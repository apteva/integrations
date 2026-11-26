import { afterEach, describe, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const app = getAppTemplate("tiktok-ads") as AppTemplate;
const tool = (name: string) => {
  const found = app.tools.find(t => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found as AppToolTemplate;
};
const credentials = { access_token: "tiktok-token", token: "tiktok-token", client_id: "app-1", client_secret: "secret-1" };

describe("tiktok-ads OAuth", () => {
  test("uses TikTok's advertiser login instead of the standard grant", () => {
    const oauth = app.auth.oauth2!;
    expect(oauth.client_id_param_name).toBe("app_id");
    expect(oauth.token_request).toEqual({
      body_format: "json",
      fields: { app_id: "{{client_id}}", secret: "{{client_secret}}", auth_code: "{{code}}" },
    });
    expect(oauth.token_response_path).toBe("data");
    expect(oauth.token_error).toEqual({ type: "json_status", code_path: "code", success_codes: [0], message_path: "message" });
    // rid only appears in TikTok's docs-portal links; it is not an auth parameter.
    expect(oauth.extra_authorize_params).toBeUndefined();
    // Advertiser tokens neither expire nor refresh.
    expect(oauth.refresh).toBeUndefined();
  });

  test("app_id and secret come from the OAuth client, not credential fields", () => {
    expect(app.auth.credential_fields!.map(f => f.name)).toEqual(["token", "advertiser_id"]);
    expect(app.auth.headers).toEqual({ "Access-Token": "{{token}}" });
  });
});

describe("tiktok-ads tools", () => {
  test("every tool detects TikTok's HTTP 200 errors and retries its rate limit", () => {
    for (const t of app.tools) {
      expect(t.response_error, t.name).toEqual({ type: "json_status", code_path: "code", success_codes: [0], message_path: "message" });
      expect(t.rate_limit?.retry_error_codes, t.name).toContain(40100);
    }
  });

  test("GET tools send array and object inputs as JSON text", () => {
    for (const t of app.tools.filter(t => t.method === "GET")) {
      for (const [name, spec] of Object.entries(t.input_schema.properties || {})) {
        const type = (spec as { type?: string }).type;
        if (type === "array" || type === "object") {
          expect(t.query_param_serialization?.[name], `${t.name}.${name}`).toBe("json");
        }
      }
    }
  });

  test("campaign_list encodes fields and filtering as TikTok reads them", async () => {
    let query: URLSearchParams | undefined;
    let headers: Headers | undefined;
    globalThis.fetch = (async (url, init) => {
      query = new URL(String(url)).searchParams;
      headers = new Headers(init?.headers);
      return Response.json({ code: 0, message: "OK", data: { list: [] } });
    }) as typeof fetch;
    const result = await executeTool({
      app,
      tool: tool("campaign_list"),
      credentials,
      input: { advertiser_id: "7123456789012345678", fields: ["campaign_id", "campaign_name"], filtering: { primary_status: "STATUS_ALL" } },
    });
    expect(result.success).toBe(true);
    expect(query!.get("fields")).toBe('["campaign_id","campaign_name"]');
    expect(query!.get("filtering")).toBe('{"primary_status":"STATUS_ALL"}');
    expect(headers!.get("Access-Token")).toBe("tiktok-token");
  });

  test("an HTTP 200 with a non-zero code is a failure carrying TikTok's message", async () => {
    globalThis.fetch = (async () => Response.json({ code: 40105, message: "Access token is incorrect or has been revoked", request_id: "r", data: {} })) as typeof fetch;
    const result = await executeTool({ app, tool: tool("campaign_list"), credentials, input: { advertiser_id: "1" } });
    expect(result.success).toBe(false);
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ error: "upstream_api_error", code: 40105, message: "Access token is incorrect or has been revoked" });
  });

  test("list_advertisers sends the connection's app_id and secret", async () => {
    let query: URLSearchParams | undefined;
    globalThis.fetch = (async url => {
      query = new URL(String(url)).searchParams;
      return Response.json({ code: 0, message: "OK", data: { list: [] } });
    }) as typeof fetch;
    await executeTool({ app, tool: tool("list_advertisers"), credentials, input: {} });
    expect(query!.get("app_id")).toBe("app-1");
    expect(query!.get("secret")).toBe("secret-1");
    expect(Object.keys(tool("list_advertisers").input_schema.properties || {})).toEqual([]);
  });

  test("ad_delete always sends operation_status DELETE", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ code: 0, message: "OK", data: {} });
    }) as typeof fetch;
    const t = tool("ad_delete");
    expect(Object.keys(t.input_schema.properties || {})).not.toContain("operation_status");
    await executeTool({ app, tool: t, credentials, input: { advertiser_id: "1", ad_ids: ["a"], operation_status: "ENABLE" } });
    expect(body).toEqual({ advertiser_id: "1", ad_ids: ["a"], operation_status: "DELETE" });
  });

  test("audience and ad group edits send TikTok's fields at the top level", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ code: 0, message: "OK", data: {} });
    }) as typeof fetch;
    await executeTool({
      app,
      tool: tool("custom_audience_update"),
      credentials,
      input: { advertiser_id: "1", custom_audience_id: "aud-1", file_paths: ["path-1"], action: "APPEND" },
    });
    expect(body).toEqual({ advertiser_id: "1", custom_audience_id: "aud-1", file_paths: ["path-1"], action: "APPEND" });
    for (const name of ["adgroup_update", "custom_audience_create", "custom_audience_update"]) {
      expect(Object.keys(tool(name).input_schema.properties || {}), name).not.toContain("data");
    }
  });

  test("adds the tools the Ads app needs", () => {
    const expected: Record<string, [string, string]> = {
      campaign_update_status: ["POST", "/campaign/status/update/"],
      ad_update: ["POST", "/ad/update/"],
      identity_list: ["GET", "/identity/get/"],
      image_info: ["GET", "/file/image/ad/info/"],
      video_info: ["GET", "/file/video/ad/info/"],
      custom_audience_file_upload: ["POST", "/dmp/custom_audience/file/upload/"],
      custom_audience_delete: ["POST", "/dmp/custom_audience/delete/"],
      lookalike_create: ["POST", "/dmp/custom_audience/lookalike/create/"],
    };
    for (const [name, [method, path]] of Object.entries(expected)) {
      expect([tool(name).method, tool(name).path], name).toEqual([method, path]);
    }
    expect(tool("custom_audience_file_upload").multipart_form).toEqual({
      file_fields: { file: "file" },
      field_names: ["advertiser_id", "file_name", "file_signature", "calculate_type"],
    });
  });
});
