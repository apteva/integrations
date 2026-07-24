import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function facebookAds(): AppTemplate {
  const app = getAppTemplate("facebook-ads");
  if (!app) throw new Error("Missing Facebook Ads integration catalog");
  return app;
}

function facebookAdsTool(name: string): AppToolTemplate {
  const tool = facebookAds().tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Facebook Ads tool: ${name}`);
  return tool;
}

describe("Facebook Ads integration catalog", () => {
  test("uses Meta Graph API resource edges instead of legacy pseudo-routes", () => {
    const expectedRoutes: Array<[string, string, string]> = [
      ["account_list", "GET", "/me/adaccounts"],
      ["campaign_create", "POST", "/{adAccountId}/campaigns"],
      ["campaign_list", "GET", "/{adAccountId}/campaigns"],
      ["campaign_update", "POST", "/{campaignId}"],
      ["adset_create", "POST", "/{adAccountId}/adsets"],
      ["adset_list", "GET", "/{objectId}/adsets"],
      ["ad_create", "POST", "/{adAccountId}/ads"],
      ["ad_list", "GET", "/{objectId}/ads"],
      ["creative_create", "POST", "/{adAccountId}/adcreatives"],
      ["creative_upload_image", "POST", "/{adAccountId}/adimages"],
      ["creative_upload_video", "POST", "/{adAccountId}/advideos"],
      ["audience_list", "GET", "/{adAccountId}/customaudiences"],
      ["insights_get", "GET", "/{objectId}/insights"],
      ["pixel_create", "POST", "/{adAccountId}/adspixels"],
      ["pixel_send_event", "POST", "/{pixelId}/events"],
      ["leadform_create", "POST", "/{pageId}/leadgen_forms"],
      ["leadform_list", "GET", "/{pageId}/leadgen_forms"],
      ["leads_get", "GET", "/{objectId}/leads"],
    ];

    for (const [name, method, path] of expectedRoutes) {
      expect(facebookAdsTool(name)).toMatchObject({ method, path });
    }

    for (const tool of facebookAds().tools) {
      expect(tool.path).not.toMatch(/^\/[a-z]+-[a-z-]+$/);
    }
  });

  test("keeps every Graph path parameter explicit and required", () => {
    for (const tool of facebookAds().tools) {
      const pathParameters = [...tool.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const parameter of pathParameters) {
        expect(tool.input_schema.properties?.[parameter]).toBeDefined();
        expect(tool.input_schema.required).toContain(parameter);
      }
    }
  });

  test("requests ad accounts from the user adaccounts edge", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: facebookAds(),
        tool: facebookAdsTool("account_list"),
        credentials: { access_token: "meta-token" },
        input: {
          fields: "id,name,account_id,account_status,currency,timezone_name",
          limit: 100,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe(
      "https://graph.facebook.com/v25.0/me/adaccounts?fields=id%2Cname%2Caccount_id%2Caccount_status%2Ccurrency%2Ctimezone_name&limit=100",
    );
    expect(captured?.init.method).toBe("GET");
    expect(captured?.init.headers).toMatchObject({
      Authorization: "Bearer meta-token",
    });
  });

  test("requests the permissions needed by ads and lead workflows", () => {
    expect(facebookAds().auth.oauth2?.scopes).toEqual(
      expect.arrayContaining([
        "ads_read",
        "ads_management",
        "business_management",
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_ads",
        "leads_retrieval",
      ]),
    );
  });
});
