import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function github(): AppTemplate {
  const app = getAppTemplate("github");
  if (!app) throw new Error("Missing GitHub integration catalog");
  return app;
}

function githubTool(name: string): AppToolTemplate {
  const tool = github().tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing GitHub tool: ${name}`);
  return tool;
}

describe("GitHub integration catalog", () => {
  test("covers complete agent-oriented repository workflows", () => {
    const app = github();
    expect(app.tools).toHaveLength(111);
    expect(new Set(app.tools.map((tool) => tool.name)).size).toBe(app.tools.length);
    expect(app.auth.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(app.auth.credential_fields?.map((field) => field.name)).toEqual(["token"]);
    expect(app.auth.oauth2?.scopes).toEqual(
      expect.arrayContaining(["repo", "workflow", "read:org", "notifications", "delete_repo"]),
    );

    const routes: Array<[string, string, string]> = [
      ["list_root_contents", "GET", "/repos/{owner}/{repo}/contents"],
      ["create_repo", "POST", "/user/repos"],
      ["create_git_blob", "POST", "/repos/{owner}/{repo}/git/blobs"],
      ["create_git_tree", "POST", "/repos/{owner}/{repo}/git/trees"],
      ["create_git_commit", "POST", "/repos/{owner}/{repo}/git/commits"],
      ["update_git_ref", "PATCH", "/repos/{owner}/{repo}/git/refs/{ref}"],
      ["create_pull_review", "POST", "/repos/{owner}/{repo}/pulls/{pull_number}/reviews"],
      ["trigger_workflow", "POST", "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"],
      ["list_repo_workflow_runs", "GET", "/repos/{owner}/{repo}/actions/runs"],
      ["rerun_failed_workflow_jobs", "POST", "/repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs"],
      ["download_workflow_job_logs", "GET", "/repos/{owner}/{repo}/actions/jobs/{job_id}/logs"],
      ["get_workflow_pending_deployments", "GET", "/repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments"],
      ["download_artifact", "GET", "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}"],
      ["upload_release_asset", "POST", "/repos/{owner}/{repo}/releases/{release_id}/assets"],
      ["list_webhook_deliveries", "GET", "/repos/{owner}/{repo}/hooks/{hook_id}/deliveries"],
      ["get_rate_limit", "GET", "/rate_limit"],
    ];

    for (const [name, method, path] of routes) {
      expect(githubTool(name)).toMatchObject({ method, path });
    }

    expect(githubTool("upload_release_asset")).toMatchObject({
      base_url: "https://uploads.github.com",
      body_binary_param: "file",
      query_params: ["name", "label"],
    });
  });

  test("keeps every path parameter explicit and required", () => {
    for (const tool of github().tools) {
      const pathParameters = [...tool.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const parameter of pathParameters) {
        expect(tool.input_schema.properties?.[parameter]).toBeDefined();
        expect(tool.input_schema.required).toContain(parameter);
      }
    }
  });

  test("separates root contents from path-based content retrieval", () => {
    expect(githubTool("list_root_contents").input_schema.required).toEqual(["owner", "repo"]);
    expect(githubTool("get_contents").input_schema.required).toEqual(["owner", "repo", "path"]);
  });

  test("sends delete_file commit fields as a JSON DELETE body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ commit: { sha: "new-sha" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: github(),
        tool: githubTool("delete_file"),
        credentials: { access_token: "github-token" },
        input: {
          owner: "octocat",
          repo: "hello-world",
          path: "docs/old.md",
          message: "Remove obsolete documentation",
          sha: "blob-sha",
          branch: "main",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe(
      "https://api.github.com/repos/octocat/hello-world/contents/docs%2Fold.md",
    );
    expect(captured?.url).not.toContain("message=");
    expect(captured?.init.method).toBe("DELETE");
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      message: "Remove obsolete documentation",
      sha: "blob-sha",
      branch: "main",
    });
    expect(captured?.init.headers).toMatchObject({
      Authorization: "Bearer github-token",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  test("dispatches a workflow with the current response-returning API contract", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({
        workflow_run_id: 123456789,
        run_url: "https://api.github.com/repos/acme/ios/actions/runs/123456789",
        html_url: "https://github.com/acme/ios/actions/runs/123456789",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const result = await executeTool({
        app: github(),
        tool: githubTool("trigger_workflow"),
        credentials: { access_token: "github-token" },
        input: {
          owner: "acme",
          repo: "ios",
          workflow_id: "deploy.yml",
          ref: "main",
          inputs: { release_channel: "testflight", upload: true },
        },
      });
      expect(result.data).toMatchObject({ workflow_run_id: 123456789 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe(
      "https://api.github.com/repos/acme/ios/actions/workflows/deploy.yml/dispatches",
    );
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      ref: "main",
      inputs: { release_channel: "testflight", upload: true },
    });
    expect(captured?.init.headers).toMatchObject({
      Authorization: "Bearer github-token",
      "X-GitHub-Api-Version": "2026-03-10",
    });
  });
});
