import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const expectedToolCounts: Record<string, number> = {
  dataimpulse: 23,
  packetstream: 8,
  "proxy-cheap": 6,
  decodo: 16,
  iproyal: 23,
  webshare: 23,
};

function app(slug: string): AppTemplate {
  const result = getAppTemplate(slug);
  if (!result) throw new Error(`Missing residential proxy integration: ${slug}`);
  return result;
}

function tool(slug: string, name: string): AppToolTemplate {
  const result = app(slug).tools.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing ${slug} tool: ${name}`);
  return result;
}

describe("residential proxy integration catalogs", () => {
  test("load with unique explicit tools and valid required path parameters", () => {
    for (const [slug, count] of Object.entries(expectedToolCounts)) {
      const catalog = app(slug);
      expect(catalog.tools).toHaveLength(count);
      expect(new Set(catalog.tools.map(({ name }) => name)).size).toBe(count);
      expect(catalog.health_check?.tool).toBeDefined();
      expect(catalog.tools.some(({ name }) => name === catalog.health_check?.tool)).toBe(true);

      for (const candidate of catalog.tools) {
        expect(candidate.description.length).toBeGreaterThan(15);
        expect(candidate.body_root_param).toBeUndefined();
        expect(candidate.input_schema.properties?.body).toBeUndefined();

        const pathParameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
          (match) => match[1],
        );
        for (const parameter of pathParameters) {
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
          expect(candidate.input_schema.required).toContain(parameter);
        }
        for (const parameter of candidate.query_params ?? []) {
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        }
      }
    }
  });

  test("uses each provider's documented authentication scheme", () => {
    expect(app("dataimpulse").auth.headers?.Authorization).toBe("Bearer {{token}}");
    expect(app("packetstream").auth.headers?.Authorization).toBe("Bearer {{token}}");
    expect(app("proxy-cheap").auth.headers).toMatchObject({
      "X-Api-Key": "{{api_key}}",
      "X-Api-Secret": "{{api_secret}}",
    });
    expect(app("decodo").auth.headers?.Authorization).toBe("{{api_key}}");
    expect(app("iproyal").auth.headers?.Authorization).toBe("Bearer {{api_token}}");
    expect(app("webshare").auth.headers?.Authorization).toBe("Token {{api_key}}");
  });

  test("covers practical proxy retrieval, usage, and account management flows", () => {
    expect(tool("dataimpulse", "get_sub_user_usage_detail")).toMatchObject({
      method: "GET",
      path: "/reseller/sub-user/usage-stat/detail",
    });
    expect(tool("packetstream", "get_sub_user_transactions")).toMatchObject({
      method: "POST",
      path: "/reseller/sub_users/view_txs",
    });
    expect(tool("proxy-cheap", "execute_order")).toMatchObject({
      method: "POST",
      path: "/v2/order/{service_id}/execute",
    });
    expect(tool("decodo", "generate_proxy_endpoints")).toMatchObject({
      method: "GET",
      path: "/v2/endpoints-custom/back-connect",
    });
    expect(tool("decodo", "get_traffic_statistics")).toMatchObject({
      method: "POST",
      path: "/api/v2/statistics/traffic",
    });
    expect(tool("iproyal", "generate_proxy_list")).toMatchObject({
      method: "POST",
      path: "/access/generate-proxy-list",
    });
    expect(tool("webshare", "list_proxies")).toMatchObject({
      method: "GET",
      path: "/proxy/list/",
    });
    expect(tool("webshare", "list_proxies").input_schema.properties?.mode).toMatchObject({
      enum: ["direct", "backbone"],
    });
  });

  test("makes balance-changing and purchase arguments concrete", () => {
    expect(tool("packetstream", "give_sub_user_balance").input_schema.required).toEqual([
      "username",
      "amount_usd_cents",
    ]);
    expect(tool("proxy-cheap", "price_order").input_schema.properties).toHaveProperty("traffic");
    expect(tool("proxy-cheap", "execute_order").input_schema.properties).toHaveProperty(
      "autoExtend",
    );
    expect(tool("iproyal", "create_order").input_schema.properties).toHaveProperty(
      "order_billing_type",
    );
  });
});
