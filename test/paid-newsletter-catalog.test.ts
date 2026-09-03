import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function app(slug: string): AppTemplate {
  const value = getAppTemplate(slug);
  if (!value) throw new Error(`Missing paid-newsletter integration: ${slug}`);
  return value;
}

function tool(slug: string, name: string): AppToolTemplate {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug} tool: ${name}`);
  return value;
}

describe("paid newsletter integration catalogs", () => {
  test("load broad, route-unique toolsets with valid path schemas", () => {
    const expectedCounts: Record<string, number> = {
      memberful: 2,
      ghost: 29,
      buttondown: 28,
      beehiiv: 35,
      convertkit: 27,
    };

    for (const [slug, count] of Object.entries(expectedCounts)) {
      const catalog = app(slug);
      expect(catalog.tools).toHaveLength(count);
      expect(new Set(catalog.tools.map(({ name }) => name)).size).toBe(count);
      expect(
        new Set(catalog.tools.map(({ method, path }) => `${method} ${path}`)).size,
      ).toBe(count);

      for (const candidate of catalog.tools) {
        for (const match of candidate.path.matchAll(/\{([^}]+)\}/g)) {
          const parameter = match[1];
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
          expect(candidate.input_schema.required).toContain(parameter);
        }
      }
    }
  });

  test("keeps source catalogs byte-identical to server mirrors", () => {
    for (const slug of ["memberful", "ghost", "buttondown", "beehiiv", "convertkit"]) {
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url));
      const mirror = readFileSync(
        new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url),
      );
      expect(mirror.equals(source)).toBe(true);
    }
  });

  test("executes Memberful GraphQL against the account-scoped endpoint", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ data: { members: { edges: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("memberful"),
      tool: tool("memberful", "graphql_request"),
      credentials: {
        fields: {
          account_url: "https://publisher.memberful.com",
          api_key: "memberful-secret",
        },
      },
      input: {
        query: "query Members($first: Int!) { members(first: $first) { edges { node { id } } } }",
        variables: { first: 20 },
      },
    });

    expect(captured?.url).toBe("https://publisher.memberful.com/api/graphql");
    expect(new Headers(captured?.init.headers).get("Authorization")).toBe(
      "Bearer memberful-secret",
    );
    expect(JSON.parse(String(captured?.init.body))).toMatchObject({ variables: { first: 20 } });
  });

  test("builds a Memberful-hosted paid checkout URL without making a request", async () => {
    globalThis.fetch = async () => {
      throw new Error("checkout URL generation must not fetch");
    };

    const result = await executeTool({
      app: app("memberful"),
      tool: tool("memberful", "build_checkout_url"),
      credentials: {
        fields: {
          account_url: "https://publisher.memberful.com",
          api_key: "memberful-secret",
        },
      },
      input: { plan: "140", members: 10 },
    });

    expect(result).toMatchObject({
      success: true,
      status: 200,
      data: { url: "https://publisher.memberful.com/checkout?plan=140&members=10" },
    });
  });

  test("creates Ghost paid tiers and offers with wrapped Admin API bodies", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("ghost"),
      tool: tool("ghost", "create_tier"),
      credentials: {
        fields: {
          site_url: "https://publisher.ghost.io",
          admin_api_key: `key:${"ab".repeat(32)}`,
          api_version: "v5.0",
        },
      },
      input: {
        name: "Premium",
        monthly_price: 900,
        yearly_price: 9000,
        currency: "eur",
        benefits: ["Premium newsletter"],
      },
    });

    await executeTool({
      app: app("ghost"),
      tool: tool("ghost", "create_offer"),
      credentials: {
        fields: {
          site_url: "https://publisher.ghost.io",
          admin_api_key: `key:${"ab".repeat(32)}`,
          api_version: "v5.0",
        },
      },
      input: {
        name: "Launch",
        code: "launch",
        type: "percent",
        cadence: "year",
        amount: 20,
        duration: "once",
        tier: { id: "tier-1" },
      },
    });

    expect(bodies[0]).toEqual({
      tiers: [
        {
          name: "Premium",
          monthly_price: 900,
          yearly_price: 9000,
          currency: "eur",
          benefits: ["Premium newsletter"],
        },
      ],
    });
    expect(bodies[1]).toMatchObject({ offers: [{ code: "launch", tier: { id: "tier-1" } }] });
  });

  test("covers paid access primitives in beehiiv and Buttondown", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ data: {}, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("beehiiv"),
      tool: tool("beehiiv", "update_subscription"),
      credentials: { token: "beehiiv-secret" },
      input: {
        publication_id: "pub-1",
        subscription_id: "sub-1",
        tier: "premium",
        premium_tier_ids: ["tier-1"],
        stripe_customer_id: "cus-1",
      },
    });

    await executeTool({
      app: app("buttondown"),
      tool: tool("buttondown", "create_price"),
      credentials: { api_key: "buttondown-secret" },
      input: { amount: 1200, cadence: "month", currency: "usd", style: "fixed" },
    });

    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      tier: "premium",
      premium_tier_ids: ["tier-1"],
      stripe_customer_id: "cus-1",
    });
    expect(calls[1].url).toBe("https://api.buttondown.com/v1/prices");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      amount: 1200,
      cadence: "month",
      currency: "usd",
      style: "fixed",
    });
  });

  test("wraps Kit purchase records in the required purchase object", async () => {
    let body: unknown;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ purchase: { id: 1 } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("convertkit"),
      tool: tool("convertkit", "create_purchase"),
      credentials: { token: "kit-secret" },
      input: {
        email_address: "reader@example.com",
        transaction_id: "txn-1",
        status: "paid",
        total: 12,
        currency: "EUR",
        transaction_time: "2026-09-03T12:00:00Z",
        products: [{ name: "Premium newsletter", quantity: 1, unit_price: 12 }],
      },
    });

    expect(body).toEqual({
      purchase: {
        email_address: "reader@example.com",
        transaction_id: "txn-1",
        status: "paid",
        total: 12,
        currency: "EUR",
        transaction_time: "2026-09-03T12:00:00Z",
        products: [{ name: "Premium newsletter", quantity: 1, unit_price: 12 }],
      },
    });
  });
});
