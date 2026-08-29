import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function app(): AppTemplate {
  const found = getAppTemplate("apteva-instance");
  if (!found) throw new Error("Missing Apteva Instance integration catalog");
  return found;
}

function tool(name: string): AppToolTemplate {
  const found = app().tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing apteva-instance.${name}`);
  return found;
}

describe("Apteva Instance integration catalog", () => {
  test("exposes the reusable remote administration surface", () => {
    expect(app().base_url).toBe("{{credential.base_url}}");
    expect(app().auth.headers).toMatchObject({ Authorization: "Bearer {{api_key}}" });
    expect(app().auth.credential_fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "base_url", exposure: "public", required: true }),
      expect.objectContaining({ name: "api_key", type: "password", required: true }),
    ]));
    expect(new Set(app().tools.map((candidate) => candidate.name))).toEqual(new Set([
      "health",
      "version",
      "provision_apply",
      "apps_list",
      "app_install",
      "app_config_update",
      "app_upgrade",
    ]));
    expect(tool("provision_apply")).toMatchObject({
      method: "PUT",
      path: "/api/provisioning/apply",
      timeout_ms: 600000,
    });
  });

  test("resolves the instance origin, bearer key, and provisioning body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ status: "applied" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app: app(),
        tool: tool("provision_apply"),
        credentials: { fields: { base_url: "https://customer.example/", api_key: "sk-secret" } },
        input: {
          request_id: "account-1:phone:1",
          tenant_id: "account-1",
          revoked_grant_ids: ["old-phone"],
          bundle: { tenant_id: "account-1", bundle_id: "phone", revision: 1, apps: [] },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://customer.example/api/provisioning/apply");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer sk-secret" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      request_id: "account-1:phone:1",
      tenant_id: "account-1",
      revoked_grant_ids: ["old-phone"],
      bundle: { tenant_id: "account-1", bundle_id: "phone", revision: 1, apps: [] },
    });
  });
});
