import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function buildkite(): AppTemplate {
  const app = getAppTemplate("buildkite");
  if (!app) throw new Error("Missing Buildkite integration catalog");
  return app;
}

function tool(name: string): AppToolTemplate {
  const found = buildkite().tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Buildkite tool: ${name}`);
  return found;
}

describe("Buildkite integration catalog", () => {
  test("covers pipelines, builds, jobs, logs, artifacts, schedules, and agents", () => {
    const app = buildkite();
    expect(app.tools).toHaveLength(51);
    expect(new Set(app.tools.map((candidate) => candidate.name)).size).toBe(51);
    expect(app.health_check).toEqual({ tool: "get_current_user", input: {} });
    expect(app.auth.headers).toMatchObject({
      Authorization: "Bearer {{token}}",
      "Content-Type": "application/json",
    });

    expect(tool("create_pipeline").path).toBe(
      "/organizations/{org_slug}/pipelines",
    );
    expect(tool("create_build")).toMatchObject({
      method: "POST",
      path: "/organizations/{org_slug}/pipelines/{pipeline_slug}/builds",
    });
    expect(tool("list_build_jobs").path).toContain("/builds/{build_number}/jobs");
    expect(tool("get_job_log").header_params).toEqual({
      accept: "Accept",
      range: "Range",
    });
    expect(tool("download_artifact").path).toBe(
      "/organizations/{org_slug}/jobs/{job_id}/artifacts/{artifact_id}/download",
    );
    expect(tool("create_pipeline_schedule").input_schema.required).toEqual(
      expect.arrayContaining(["label", "cronline"]),
    );
    expect(tool("pause_agent").path).toBe(
      "/organizations/{org_slug}/agents/{agent_id}/pause",
    );
  });

  test("keeps every path parameter explicit and required", () => {
    for (const candidate of buildkite().tools) {
      const parameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const parameter of parameters) {
        expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        expect(candidate.input_schema.required).toContain(parameter);
      }
    }
  });

  test("sends a typed build payload while keeping route fields out of the body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(
        JSON.stringify({ id: "build-id", number: 42, state: "scheduled" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const result = await executeTool({
        app: buildkite(),
        tool: tool("create_build"),
        credentials: { fields: { token: "buildkite-token" } },
        input: {
          org_slug: "acme",
          pipeline_slug: "ios-release",
          commit: "HEAD",
          branch: "main",
          message: "Release build",
          env: { CHANNEL: "production" },
          clean_checkout: true,
        },
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ number: 42 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe(
      "https://api.buildkite.com/v2/organizations/acme/pipelines/ios-release/builds",
    );
    expect(captured?.init.headers).toMatchObject({
      Authorization: "Bearer buildkite-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      commit: "HEAD",
      branch: "main",
      message: "Release build",
      env: { CHANNEL: "production" },
      clean_checkout: true,
    });
  });

  test("supports efficient polling and bounded log tails", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      if (String(url).endsWith("/log")) {
        return new Response("last log lines", {
          status: 206,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(JSON.stringify({ number: 42, state: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: buildkite(),
        tool: tool("get_build"),
        credentials: { fields: { token: "buildkite-token" } },
        input: {
          org_slug: "acme",
          pipeline_slug: "ios-release",
          build_number: 42,
          exclude_jobs: true,
          exclude_pipeline: true,
        },
      });
      const log = await executeTool({
        app: buildkite(),
        tool: tool("get_job_log"),
        credentials: { fields: { token: "buildkite-token" } },
        input: {
          org_slug: "acme",
          job_id: "job-123",
          accept: "text/plain",
          range: "bytes=-65536",
        },
      });
      expect(log.data).toBe("last log lines");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured[0].url).toBe(
      "https://api.buildkite.com/v2/organizations/acme/pipelines/ios-release/builds/42?exclude_jobs=true&exclude_pipeline=true",
    );
    expect(captured[0].init.body).toBeUndefined();
    expect(captured[1].url).toBe(
      "https://api.buildkite.com/v2/organizations/acme/jobs/job-123/log",
    );
    expect(captured[1].init.headers).toMatchObject({
      Accept: "text/plain",
      Range: "bytes=-65536",
    });
  });
});
