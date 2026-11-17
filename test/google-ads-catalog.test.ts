import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import { generateMcpServer } from "../src/mcp-generator.js";
import type { AppTemplate, Connection } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function app(): AppTemplate {
  const value = getAppTemplate("google-ads");
  if (!value) throw new Error("Missing Google Ads integration catalog");
  return value;
}
function tool(name: string) {
  const value = app().tools.find(t => t.name === name);
  if (!value) throw new Error(`Missing google-ads.${name}`);
  return value;
}
async function record(name: string, input: Record<string, unknown>, response: unknown = {}, status = 200) {
  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    request = { url: String(url), init: init || {} };
    return Response.json(response, { status });
  }) as typeof fetch;
  const result = await executeTool({ app: app(), tool: tool(name), input, credentials: {
    access_token: "test-token", fields: { developer_token: "test-developer", manager_customer_id: "1234567890" },
  } });
  if (!request) throw new Error("No HTTP request");
  return { ...request, headers: new Headers(request.init.headers), result };
}

describe("Google Ads integration credentials", () => {
  test("separates operator inputs from OAuth-generated fields", () => {
    const app = getAppTemplate("google-ads");
    if (!app) throw new Error("Missing Google Ads integration catalog");

    const fields = app.auth.credential_fields || [];
    const byName = new Map(fields.map((field) => [field.name, field]));

    expect(byName.get("developer_token")).toMatchObject({
      source: "user",
      type: "password",
      required: true,
    });
    expect(byName.get("manager_customer_id")).toMatchObject({
      source: "user",
      type: "text",
      required: false,
    });
    for (const name of ["token", "refresh_token", "expires_in", "token_type"]) {
      expect(byName.get(name)).toMatchObject({
        source: "oauth",
        hidden: true,
        required: false,
      });
    }
  });
});

// Wire contracts verified against the official v23 service protos:
// https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v23/services/google_ads_field_service.proto
// https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v23/services/google_ads_service.proto
describe("Google Ads generic attribution queries", () => {
  test("source and embedded catalog match and query tools remain unrestricted", () => {
    const source = readFileSync(new URL("../src/apps/google-ads.json", import.meta.url));
    expect(readFileSync(new URL("../../server/integrations-catalog/google-ads.json", import.meta.url)).equals(source)).toBe(true);
    for (const name of ["search", "search_stream", "report_search", "report_search_stream"]) {
      const s = tool(name).input_schema as any;
      expect(s.properties.query.type).toBe("string");
      expect(s.properties.query.enum).toBeUndefined();
      expect(s.required).toEqual(["customer_id", "query"]);
      expect(tool(name).response_path).toBeUndefined();
      expect(tool(name).response_omit).toBeUndefined();
    }
    const guide = tool("search").description;
    for (const field of ["conversion_action.id", "conversion_action.name", "conversion_action.type", "conversion_action.category", "conversion_action.origin", "conversion_action.status", "metrics.conversions_value", "metrics.all_conversions", "metrics.all_conversions_value", "asset.id", "campaign_asset.field_type", "asset.call_asset.phone_number", "call_view.call_status", "call_view.call_duration_seconds", "call_view.start_call_date_time", "click_view.gclid", "segments.conversion_action"]) {
      expect(guide).toContain(field);
    }
    expect(guide).toContain("90 days");
    expect(guide).toContain("qualified is not a call_view status");
    expect(JSON.stringify(app())).not.toContain("flexyleadCampaignId");
    expect(JSON.stringify(app())).not.toContain("attributionStatus");
  });

  test("any GAQL resource passes through every search/report tool with native responses", async () => {
    const examples = [
      ["conversion_action", "conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.origin, conversion_action.status"],
      ["campaign_asset", "campaign.id, campaign_asset.asset, asset.id, asset.call_asset.phone_number"],
      ["call_view", "campaign.id, ad_group.id, call_view.resource_name, call_view.call_status, call_view.call_duration_seconds"],
      ["click_view", "click_view.gclid, click_view.ad_group_ad"],
      ["customer_asset", "customer_asset.asset, asset.id"],
    ];
    for (const name of ["search", "report_search", "search_stream", "report_search_stream"]) {
      for (const [resource, fields] of examples) {
        const query = `SELECT ${fields} FROM ${resource}${resource === "click_view" ? " WHERE segments.date = '2026-09-01'" : ""}`;
        const native = { results: [{ conversionAction: { id: "42", name: "Phone call", type: "AD_CALL", status: "ENABLED" }, metrics: { conversions: 0.5, conversionsValue: 75, allConversions: 2.5, allConversionsValue: 150 }, campaignAsset: { asset: "customers/123/assets/5", fieldType: "CALL" }, asset: { id: "5", callAsset: { phoneNumber: "+34911234567" } }, callView: { resourceName: "customers/123/callViews/abc", callStatus: "MISSED", callDurationSeconds: "0" }, clickView: { gclid: "test-gclid" } }], fieldMask: "conversionAction.id", requestId: "test-request", nextPageToken: "next-token" };
        const response = name.includes("stream") ? [native, { summaryRow: { metrics: { conversions: 0.5 } }, requestId: "summary" }] : native;
        const r = await record(name, { customer_id: "9876543210", query }, response);
        expect(r.url).toBe(`https://googleads.googleapis.com/v23/customers/9876543210/googleAds:${name.includes("stream") ? "searchStream" : "search"}`);
        expect(JSON.parse(String(r.init.body))).toEqual({ query });
        expect(r.headers.get("Authorization")).toBe("Bearer test-token");
        expect(r.headers.get("developer-token")).toBe("test-developer");
        expect(r.headers.get("login-customer-id")).toBe("1234567890");
        expect(r.result.data).toEqual(response);
      }
    }
  });

  test("paginated tools translate legacy page_token and expose native validation/settings", async () => {
    const query = "SELECT campaign.id, metrics.conversions_value FROM campaign";
    for (const name of ["search", "report_search"]) {
      for (const pagination of [{ page_token: "opaque-token" }, { pageToken: "opaque-token" }]) {
        const r = await record(name, { customer_id: "123", query, ...pagination, validateOnly: false, searchSettings: { returnSummaryRow: true, returnTotalResultsCount: true, omitResults: false } });
        expect(JSON.parse(String(r.init.body))).toEqual({ query, pageToken: "opaque-token", validateOnly: false, searchSettings: { returnSummaryRow: true, returnTotalResultsCount: true, omitResults: false } });
        expect(r.url).not.toContain("opaque-token");
      }
      const r = await record(name, { customer_id: "123", query, validateOnly: true });
      expect(JSON.parse(String(r.init.body))).toEqual({ query, validateOnly: true });
      const s = tool(name).input_schema as any;
      expect(s.not).toEqual({ required: ["pageToken", "page_token"] });
      expect(s.properties.pageSize).toBeUndefined();
    }
  });

  test("streams forward native summary-row requests and preserve empty batches", async () => {
    for (const name of ["search_stream", "report_search_stream"]) {
      const r = await record(name, { customer_id: "123", query: "SELECT metrics.conversions FROM campaign", summaryRowSetting: "SUMMARY_ROW_ONLY" }, [{ results: [], requestId: "empty" }]);
      expect(JSON.parse(String(r.init.body))).toEqual({ query: "SELECT metrics.conversions FROM campaign", summaryRowSetting: "SUMMARY_ROW_ONLY" });
      expect(r.result.data).toEqual([{ results: [], requestId: "empty" }]);
    }
  });

  test("field discovery uses provider metadata endpoints, including compatibility and pagination", async () => {
    const metadata = { name: "call_view.call_status", dataType: "ENUM", selectable: true, filterable: true, selectableWith: ["campaign", "ad_group"], enumValues: ["RECEIVED", "MISSED"] };
    const r = await record("get_field", { field_name: "call_view.call_status" }, metadata);
    expect(r.url).toBe("https://googleads.googleapis.com/v23/googleAdsFields/call_view.call_status");
    expect(r.init.method).toBe("GET");
    expect(r.init.body).toBeUndefined();
    expect(r.result.data).toEqual(metadata);
    expect(new RegExp((tool("get_field").input_schema as any).properties.field_name.pattern).test("asset.call_asset.phone_number")).toBe(true);
    const query = "SELECT name, category, selectable_with WHERE name LIKE 'call_view.%'";
    const response = { results: [metadata], nextPageToken: "metadata-next", totalResultsCount: "10" };
    const search = await record("search_fields", { query, pageToken: "metadata-page", pageSize: 100 }, response);
    expect(search.url).toBe("https://googleads.googleapis.com/v23/googleAdsFields:search");
    expect(search.init.method).toBe("POST");
    expect(JSON.parse(String(search.init.body))).toEqual({ query, pageToken: "metadata-page", pageSize: 100 });
    expect(search.result.data).toEqual(response);
    expect((tool("search_fields").input_schema as any).required).toEqual(["query"]);
  });

  test("query compatibility failures are surfaced without synthesizing campaign counts", async () => {
    const response = { error: { code: 400, message: "Incompatible fields", status: "INVALID_ARGUMENT", details: [{ requestId: "invalid-query" }] } };
    const r = await record("search", { customer_id: "123", query: "SELECT invalid.field FROM campaign", validateOnly: true }, response, 400);
    expect(r.result.success).toBe(false);
    expect(r.result.data).toEqual(response);
  });

  test("MCP generation preserves the generic schemas and pagination transform", () => {
    const generated = generateMcpServer({ id: "test", credentials: { access_token: "test-token", fields: { developer_token: "test-developer" } } } as Connection, app());
    for (const name of ["search", "report_search", "search_fields", "get_field"]) {
      const t = generated.tools.find(t => t.name === `google-ads_${name}`)!;
      expect(t.input_schema).toEqual(tool(name).input_schema);
      expect(t.http_config.request_transform).toEqual(tool(name).request_transform);
    }
  });
});
