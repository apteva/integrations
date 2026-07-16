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
    expect(app.tools).toHaveLength(103);
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
      ["list_repo_workflow_runs", "GET", "/repos/{owner}/{repo}/actions/runs"],
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
});
