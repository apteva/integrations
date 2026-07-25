import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function requireApp(slug: string): AppTemplate {
  const app = getAppTemplate(slug);
  if (!app) throw new Error(`Missing integration catalog: ${slug}`);
  return app;
}

function requireTool(app: AppTemplate, name: string): AppToolTemplate {
  const tool = app.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${app.slug} tool: ${name}`);
  return tool;
}

describe("affiliate network integration catalogs", () => {
  test("Awin covers accounts, programs, payout details, links, transactions, and click reporting", () => {
    const app = requireApp("awin");
    expect(app.auth.headers?.Authorization).toBe("Bearer {{token}}");
    expect(app.health_check).toEqual({
      tool: "accounts_list",
      input: { type: "publisher" },
      expect_status: [200],
    });
    expect(requireTool(app, "accounts_list").path).toBe("/accounts");
    expect(requireTool(app, "programs_list").path).toBe(
      "/publishers/{publisherId}/programmes",
    );
    expect(requireTool(app, "commission_groups_get").input_schema.required).toEqual([
      "publisherId",
      "advertiserId",
    ]);
    expect(requireTool(app, "tracking_link_generate")).toMatchObject({
      method: "POST",
      path: "/publishers/{publisherId}/linkbuilder/generate",
    });
    expect(requireTool(app, "transactions_list").input_schema.properties).toHaveProperty(
      "status",
    );
    expect(requireTool(app, "campaign_performance_report")).toMatchObject({
      method: "GET",
      path: "/publishers/{publisherId}/reports/campaign",
    });
  });

  test("Impact derives Basic auth and sends tracking-link fields as documented query parameters", () => {
    const app = requireApp("impact");
    expect(app.auth.credential_fields?.map((field) => field.name)).toEqual([
      "account_sid",
      "auth_token",
    ]);
    expect(requireTool(app, "public_terms_get").path).toContain("/PublicTerms");
    const link = requireTool(app, "tracking_link_create");
    expect(link.query_params).toEqual(
      expect.arrayContaining(["Type", "DeepLink", "subId1", "subId2", "sharedId"]),
    );
    expect(link.input_schema.properties).toHaveProperty("subId1");
    expect(link.input_schema.properties).not.toHaveProperty("SubId1");
  });

  test("PartnerStack uses Partner API keys, valid reward filters, and 250-record pagination", () => {
    const app = requireApp("partnerstack");
    expect(app.auth.credential_fields?.[0]).toMatchObject({
      name: "token",
      label: "PartnerStack API key",
    });
    for (const name of [
      "marketplace_programs_list",
      "partnerships_list",
      "transactions_list",
      "rewards_list",
    ]) {
      expect(requireTool(app, name).input_schema.properties?.limit).toMatchObject({
        maximum: 250,
      });
    }
    const rewardProperties = requireTool(app, "rewards_list").input_schema.properties;
    expect(rewardProperties).toHaveProperty("company_key");
    expect(rewardProperties).toHaveProperty("payment_status");
    expect(rewardProperties).toHaveProperty("invoice_key");
    expect(rewardProperties).toHaveProperty("hide_archived_rewards");
  });

  test("Sovrn keeps secret auth off Commerce link endpoints and exposes daily click reporting", () => {
    const app = requireApp("sovrn");
    expect(requireTool(app, "link_check").omit_auth_headers).toContain("Authorization");
    expect(requireTool(app, "affiliate_link_url").omit_auth_headers).toContain(
      "Authorization",
    );
    expect(requireTool(app, "merchants_by_date_report")).toMatchObject({
      method: "GET",
      path: "https://viglink.io/v1/reports/merchantsbydate",
    });
    expect(requireTool(app, "merchants_by_date_report").input_schema.required).toEqual([
      "clickDateStart",
      "clickDateEnd",
    ]);
  });

  test("Impact tracking-link execution derives Basic auth and puts documented fields in the URL", async () => {
    const app = requireApp("impact");
    const tool = requireTool(app, "tracking_link_create");
    let captured: { url: string; init?: RequestInit } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ TrackingURL: "https://example.sjv.io/c/1/2/3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app,
        tool,
        credentials: {
          fields: { account_sid: "acct-123", auth_token: "token-456" },
        },
        input: {
          program_id: "987",
          Type: "Regular",
          DeepLink: "https://merchant.example/product",
          subId1: "guide",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const request = captured as { url: string; init?: RequestInit } | null;
    expect(request?.url).toContain("/Mediapartners/acct-123/Programs/987/TrackingLinks?");
    expect(request?.url).toContain("DeepLink=https%3A%2F%2Fmerchant.example%2Fproduct");
    expect(request?.url).toContain("subId1=guide");
    expect(request?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("acct-123:token-456").toString("base64")}`,
    });
    expect(request?.init?.body).toBe("{}");
  });

  test("Sovrn Commerce link checks never leak the reporting secret", async () => {
    const app = requireApp("sovrn");
    const tool = requireTool(app, "link_check");
    let capturedHeaders: HeadersInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ optimized: "https://sovrn.co/example" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app,
        tool,
        credentials: {
          fields: { secret_key: "reporting-secret", commerce_api_key: "commerce-key" },
        },
        input: { out: "https://merchant.example/product", optimize: true, format: "json" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedHeaders).toEqual({ Accept: "application/json" });
  });
});
