import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Amazon product-intelligence catalogs", () => {
  test("adds broad Keepa research coverage with explicit cost semantics", () => {
    const keepa = getAppTemplate("keepa");
    if (!keepa) throw new Error("Missing Keepa integration catalog");

    expect(keepa.tools.map(({ name }) => name)).toEqual([
      "get_products",
      "search_products",
      "find_products",
      "list_best_sellers",
      "browse_deals",
      "lookup_categories",
      "search_categories",
      "get_sellers",
      "find_sellers",
      "list_top_sellers",
    ]);
    expect(keepa.description).toContain("estimated monthly sales");
    expect(keepa.description).toContain("paid Keepa API subscription");
    expect(keepa.auth.query_params).toEqual({ key: "{{api_key}}" });
    expect(keepa.tools.find(({ name }) => name === "get_products")?.description)
      .toContain("not verified copies sold");
  });

  test("keeps the API key private, aliases Keepa parameters, and sends finder selection at the body root", async () => {
    const keepa = getAppTemplate("keepa");
    if (!keepa) throw new Error("Missing Keepa integration catalog");
    const getProducts = keepa.tools.find(({ name }) => name === "get_products");
    const findProducts = keepa.tools.find(({ name }) => name === "find_products");
    if (!getProducts || !findProducts) throw new Error("Missing Keepa product tools");

    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      return Response.json({ products: [], tokensLeft: 99 });
    };

    await executeTool({
      app: keepa,
      tool: getProducts,
      credentials: { fields: { api_key: "keepa-secret" } },
      input: { domain: 1, asin: "B0EXAMPLE1", only_live_offers: 1 },
    });
    await executeTool({
      app: keepa,
      tool: findProducts,
      credentials: { fields: { api_key: "keepa-secret" } },
      input: {
        domain: 1,
        stats: 1,
        selection: { monthlySold_gte: 100, avg90_SALES_lte: 50000, perPage: 50 },
      },
    });

    expect(calls[0].url).toContain("key=keepa-secret");
    expect(calls[0].url).toContain("only-live-offers=1");
    expect(calls[0].url).not.toContain("only_live_offers");
    expect(calls[1].url).toContain("/query?");
    expect(calls[1].url).toContain("domain=1");
    expect(calls[1].url).toContain("stats=1");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      monthlySold_gte: 100,
      avg90_SALES_lte: 50000,
      perPage: 50,
    });
    expect(findProducts.input_schema.properties?.key).toBeUndefined();
  });

  test("documents the two official Creators API sales-rank resources", () => {
    const amazon = getAppTemplate("amazon-associates");
    if (!amazon) throw new Error("Missing Amazon Associates integration catalog");
    for (const name of ["items_search", "items_get", "variations_get"]) {
      const candidate = amazon.tools.find((tool) => tool.name === name);
      expect(candidate?.input_schema.properties?.resources.description).toContain(
        "browseNodeInfo.websiteSalesRank",
      );
      expect(candidate?.input_schema.properties?.resources.description).toContain(
        "browseNodeInfo.browseNodes.salesRank",
      );
    }
    expect(amazon.tools.find(({ name }) => name === "items_search_sales_rank")
      ?.request_transform).toMatchObject({
        type: "json_wrap",
        constants: {
          resources: [
            "browseNodeInfo.websiteSalesRank",
            "browseNodeInfo.browseNodes.salesRank",
          ],
        },
      });
    expect(amazon.tools.find(({ name }) => name === "items_get_sales_rank")
      ?.request_transform).toMatchObject({
        type: "json_wrap",
        constants: {
          resources: [
            "browseNodeInfo.websiteSalesRank",
            "browseNodeInfo.browseNodes.salesRank",
          ],
        },
      });
  });

  test("injects Creators API rank resources without asking the agent for magic strings", async () => {
    const amazon = getAppTemplate("amazon-associates");
    if (!amazon) throw new Error("Missing Amazon Associates integration catalog");
    const rankTool = amazon.tools.find(({ name }) => name === "items_get_sales_rank");
    if (!rankTool) throw new Error("Missing Amazon sales-rank tool");

    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (String(url).endsWith("/auth/o2/token")) {
        return Response.json({ access_token: "rank-token", expires_in: 3600 });
      }
      return Response.json({ itemsResult: { items: [] } });
    };

    await executeTool({
      app: amazon,
      tool: rankTool,
      credentials: {
        fields: {
          credential_id: "rank-credential",
          credential_secret: "rank-secret",
          marketplace: "www.amazon.com",
        },
      },
      input: { partnerTag: "example-20", itemIds: ["B0EXAMPLE1"] },
    });

    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({
      resources: [
        "browseNodeInfo.websiteSalesRank",
        "browseNodeInfo.browseNodes.salesRank",
      ],
      partnerTag: "example-20",
      itemIds: ["B0EXAMPLE1"],
    });
  });

  test("keeps changed source catalogs byte-identical to server mirrors", () => {
    for (const slug of ["keepa", "amazon-associates", "dataforseo"]) {
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url));
      const mirror = readFileSync(
        new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url),
      );
      expect(mirror.equals(source)).toBe(true);
    }
  });
});
