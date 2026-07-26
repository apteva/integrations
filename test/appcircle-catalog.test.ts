import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type {
  AppTemplate,
  AppToolTemplate,
  ConnectionCredentials,
} from "../src/types.js";

function appcircle(): AppTemplate {
  const app = getAppTemplate("appcircle");
  if (!app) throw new Error("Missing Appcircle integration catalog");
  return app;
}

function tool(name: string): AppToolTemplate {
  const found = appcircle().tools.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing Appcircle tool: ${name}`);
  return found;
}

describe("Appcircle integration catalog", () => {
  test("covers build, signing, distribution, publishing, reports, and webhooks", () => {
    const app = appcircle();
    expect(app.tools).toHaveLength(101);
    expect(new Set(app.tools.map((candidate) => candidate.name)).size).toBe(
      101,
    );
    expect(app.health_check).toEqual({
      tool: "list_build_profiles",
      input: {},
    });
    expect(app.auth.token_exchange).toMatchObject({
      url: "https://auth.appcircle.io/auth/v1/api-key/token",
      content_type: "application/x-www-form-urlencoded",
      access_token_path: "access_token",
      expires_in_path: "expires_in",
    });
    expect(app.auth.headers).toMatchObject({
      Authorization: "Bearer {{access_token}}",
    });

    expect(tool("start_build")).toMatchObject({
      method: "POST",
      base_url: "https://api.appcircle.io/build",
      path: "/v3/commits/{commitId}/build",
    });
    expect(tool("cancel_build").path).toBe(
      "/v3/queue/{taskId}/cancel",
    );
    expect(tool("download_build_artifacts").path).toBe(
      "/v2/commits/{commitId}/builds/{buildId}",
    );
    expect(tool("list_ios_certificates").base_url).toBe(
      "https://api.appcircle.io/signing-identity",
    );
    expect(tool("add_testers_to_testing_group").base_url).toBe(
      "https://api.appcircle.io/distribution",
    );
    expect(tool("start_publish").path).toContain(
      "/v3/profiles/{platformType}/{profileId}/publish/{publishId}/start",
    );
    expect(tool("update_rollout_status").input_schema.properties).toBeDefined();
  });

  test("keeps every path parameter explicit and required", () => {
    for (const candidate of appcircle().tools) {
      const parameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const parameter of parameters) {
        expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        expect(candidate.input_schema.required).toContain(parameter);
      }
    }
  });

  test("exchanges an organization API key and reuses the short-lived bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (String(url).includes("/auth/v1/api-key/token")) {
        return new Response(
          JSON.stringify({
            access_token: "short-lived-token",
            expires_in: 14400,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ taskId: "task-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const credentials: ConnectionCredentials = {
      fields: {
        api_key_name: "automation",
        api_key_secret: "secret-value",
        organization_id: "org-123",
      },
    };
    try {
      await executeTool({
        app: appcircle(),
        tool: tool("start_build_with_workflow"),
        credentials,
        input: {
          commitId: "commit-123",
          workflowId: "workflow-123",
          configurationId: "configuration-123",
        },
      });
      await executeTool({
        app: appcircle(),
        tool: tool("list_build_profiles"),
        credentials,
        input: {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(
      "https://auth.appcircle.io/auth/v1/api-key/token",
    );
    expect(String(calls[0].init.body)).toContain("name=automation");
    expect(String(calls[0].init.body)).toContain("secret=secret-value");
    expect(String(calls[0].init.body)).toContain(
      "organizationId=org-123",
    );
    expect(calls[1].url).toBe(
      "https://api.appcircle.io/build/v3/commits/commit-123/build/by-workflow?workflowId=workflow-123&configurationId=configuration-123",
    );
    expect(calls[1].init.headers).toMatchObject({
      Authorization: "Bearer short-lived-token",
    });
    expect(calls[2].url).toBe(
      "https://api.appcircle.io/build/v2/profiles",
    );
  });

  test("re-exchanges once when Appcircle rejects a cached token", async () => {
    let exchangeCount = 0;
    let apiCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/auth/v1/api-key/token")) {
        exchangeCount++;
        return new Response(
          JSON.stringify({
            access_token: `token-${exchangeCount}`,
            expires_in: 14400,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      apiCount++;
      return new Response(
        JSON.stringify(apiCount === 1 ? { error: "expired" } : { data: [] }),
        {
          status: apiCount === 1 ? 401 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    try {
      const result = await executeTool({
        app: appcircle(),
        tool: tool("list_build_profiles"),
        credentials: {
          fields: {
            api_key_name: "automation",
            api_key_secret: "secret-value",
          },
        },
        input: {},
      });
      expect(result.success).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(exchangeCount).toBe(2);
    expect(apiCount).toBe(2);
  });
});
