import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function bitrise(): AppTemplate {
  const app = getAppTemplate("bitrise");
  if (!app) throw new Error("Missing Bitrise integration catalog");
  return app;
}

function tool(name: string): AppToolTemplate {
  const found = bitrise().tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Bitrise tool: ${name}`);
  return found;
}

describe("Bitrise integration catalog", () => {
  test("covers build, signing, artifact, distribution, and store-release workflows", () => {
    const app = bitrise();
    expect(app.tools).toHaveLength(97);
    expect(new Set(app.tools.map((candidate) => candidate.name)).size).toBe(97);
    expect(app.health_check).toEqual({ tool: "get_current_user", input: {} });
    expect(app.auth.headers).toMatchObject({ Authorization: "{{token}}" });

    expect(tool("trigger_build")).toMatchObject({
      method: "POST",
      path: "/apps/{app_slug}/builds",
    });
    expect(tool("trigger_build").input_schema.properties).toHaveProperty(
      "build_params",
    );
    expect(tool("get_build_log").path).toBe(
      "/apps/{app_slug}/builds/{build_slug}/log",
    );
    expect(tool("list_build_artifacts").path).toBe(
      "/apps/{app_slug}/builds/{build_slug}/artifacts",
    );
    expect(tool("create_app_secret").input_schema.required).toEqual(
      expect.arrayContaining(["app_slug", "name", "value"]),
    );
    expect(tool("release_to_app_store").base_url).toContain(
      "/release-management/v2/store-releases/v1",
    );
    expect(tool("release_to_google_play").base_url).toContain(
      "/release-management/v2/store-releases/v1",
    );
    expect(tool("add_testers_to_group").input_schema.properties).toBeDefined();
  });

  test("keeps every path parameter explicit and required", () => {
    for (const candidate of bitrise().tools) {
      const parameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const parameter of parameters) {
        expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        expect(candidate.input_schema.required).toContain(parameter);
      }
    }
  });

  test("sends nested typed build parameters to the documented build route", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(
        JSON.stringify({ build_slug: "build-123", status: "ok" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const result = await executeTool({
        app: bitrise(),
        tool: tool("trigger_build"),
        credentials: { fields: { token: "bitrise-token" } },
        input: {
          app_slug: "app-123",
          build_params: {
            branch: "main",
            workflow_id: "ios-release",
            stack: "osx-xcode-16.0.x",
            machine_type_id: "g2-m1.4core",
            environments: [{ key: "CHANNEL", value: "production" }],
          },
          hook_info: { type: "bitrise" },
        },
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ build_slug: "build-123" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe(
      "https://api.bitrise.io/v0.1/apps/app-123/builds",
    );
    expect(captured?.init.headers).toMatchObject({
      Authorization: "bitrise-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      build_params: {
        branch: "main",
        workflow_id: "ios-release",
        stack: "osx-xcode-16.0.x",
        machine_type_id: "g2-m1.4core",
        environments: [{ key: "CHANNEL", value: "production" }],
      },
      hook_info: { type: "bitrise" },
    });
  });

  test("does not leak the Bitrise token to a presigned artifact upload", async () => {
    let captured: { url: string; headers: HeadersInit | undefined } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), headers: init?.headers };
      return new Response("", { status: 200 });
    };

    try {
      await executeTool({
        app: bitrise(),
        tool: tool("upload_presigned_artifact"),
        credentials: { fields: { token: "bitrise-token" } },
        input: {
          upload_url: "https://uploads.example.test/file?signature=abc",
          file: {
            _binary: true,
            base64: Buffer.from("artifact").toString("base64"),
            mimeType: "application/octet-stream",
          },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe(
      "https://uploads.example.test/file?signature=abc",
    );
    expect(captured?.headers).toEqual({
      "Content-Type": "application/octet-stream",
    });
  });
});
