import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAppCache();
});

describe("CJ Dropshipping catalog", () => {
  test("maps stable product-search inputs to Product List V2 query names", async () => {
    const app = getAppTemplate("cjdropshipping");
    if (!app) throw new Error("Missing CJ Dropshipping integration catalog");
    const tool = app.tools.find(({ name }) => name === "products_search");
    if (!tool) throw new Error("Missing CJ products_search tool");

    let requestUrl = "";
    globalThis.fetch = async (url) => {
      requestUrl = String(url);
      return Response.json({
        code: 200,
        result: true,
        data: { pageSize: 5, pageNumber: 1, totalRecords: 0, content: [] },
      });
    };

    const result = await executeTool({
      app,
      tool,
      credentials: {
        access_token: "cj-test-token",
        token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      input: {
        productNameEn: "wireless charger",
        pageNum: 2,
        pageSize: 5,
        startSellPrice: 5,
        endSellPrice: 40,
        minInventory: 10,
        maxInventory: 500,
        sortBy: 2,
        sort: "asc",
      },
    });

    expect(result.success).toBe(true);
    const query = new URL(requestUrl).searchParams;
    expect(query.get("keyWord")).toBe("wireless charger");
    expect(query.get("page")).toBe("2");
    expect(query.get("size")).toBe("5");
    expect(query.get("startSellPrice")).toBe("5");
    expect(query.get("endSellPrice")).toBe("40");
    expect(query.get("startWarehouseInventory")).toBe("10");
    expect(query.get("endWarehouseInventory")).toBe("500");
    expect(query.get("orderBy")).toBe("2");
    expect(query.get("sort")).toBe("asc");
    expect(query.has("productNameEn")).toBe(false);
    expect(query.has("pageNum")).toBe(false);
    expect(query.has("pageSize")).toBe(false);
    expect(query.has("minInventory")).toBe(false);
    expect(query.has("maxInventory")).toBe(false);
    expect(query.has("sortBy")).toBe(false);
  });

  test("paces and retries CJ rate-limit responses", async () => {
    const app = getAppTemplate("cjdropshipping");
    const catalogTool = app?.tools.find(({ name }) => name === "products_search");
    if (!app || !catalogTool) throw new Error("Missing CJ products_search tool");
    const tool = {
      ...catalogTool,
      rate_limit: {
        ...catalogTool.rate_limit!,
        min_interval_ms: 5,
        max_retries: 1,
      },
    };

    let calls = 0;
    const requestTimes: number[] = [];
    globalThis.fetch = async () => {
      calls += 1;
      requestTimes.push(Date.now());
      if (calls === 1) {
        return Response.json(
          { code: 429, result: false, message: "Too Many Requests" },
          { status: 429 },
        );
      }
      return Response.json({ code: 200, result: true, data: { content: [] } });
    };

    const result = await executeTool({
      app,
      tool,
      credentials: {
        access_token: "cj-rate-test-token",
        token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      input: { productNameEn: "desk gadget", pageSize: 5 },
    });

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(4);
  });

  test("treats an exhausted CJ semantic rate-limit response as failure", async () => {
    const app = getAppTemplate("cjdropshipping");
    const catalogTool = app?.tools.find(({ name }) => name === "products_search");
    if (!app || !catalogTool) throw new Error("Missing CJ products_search tool");
    const tool = {
      ...catalogTool,
      rate_limit: {
        ...catalogTool.rate_limit!,
        min_interval_ms: 1,
        max_retries: 0,
      },
    };
    globalThis.fetch = async () => Response.json({
      code: 1600200,
      result: false,
      message: "Interface call exceeds limit",
    });

    const result = await executeTool({
      app,
      tool,
      credentials: {
        access_token: "cj-semantic-rate-test-token",
        token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      input: { productNameEn: "smart home" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ code: 1600200 });
  });

  test("exposes only Product List V2-supported search filters", () => {
    const app = getAppTemplate("cjdropshipping");
    const tool = app?.tools.find(({ name }) => name === "products_search");
    if (!tool) throw new Error("Missing CJ products_search tool");

    const properties = tool.input_schema.properties as Record<string, unknown>;
    expect(properties.minPrice).toBeUndefined();
    expect(properties.maxPrice).toBeUndefined();
    expect(properties.features).toBeDefined();
    expect(properties.supplierId).toBeDefined();
    expect(properties.hasCertification).toBeDefined();
    expect(properties.isSelfPickup).toBeDefined();
    expect(properties.customization).toBeDefined();
    expect(properties.pageSize).toMatchObject({ default: 10, minimum: 1, maximum: 100 });
    expect(properties.sortBy).toMatchObject({
      type: "integer",
      enum: [0, 1, 2, 3, 4],
    });
    expect(tool.rate_limit).toEqual({
      min_interval_ms: 1000,
      max_retries: 2,
      retry_statuses: [429],
      retry_error_codes: [1600200],
    });
  });

  test("posts CJ's canonical freight-calculation body", async () => {
    const app = getAppTemplate("cjdropshipping");
    const tool = app?.tools.find(({ name }) => name === "shipping_calculate");
    if (!app || !tool) throw new Error("Missing CJ shipping_calculate tool");

    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return Response.json({
        code: 200,
        result: true,
        success: true,
        data: [{ logisticName: "CJPacket", logisticPrice: 8.5, logisticAging: "5-9" }],
      });
    };

    const input = {
      startCountryCode: "CN",
      endCountryCode: "US",
      zip: "10001",
      products: [{ vid: "cj-variant-1", quantity: 3 }],
    };
    const result = await executeTool({
      app,
      tool,
      credentials: {
        access_token: "cj-shipping-post-test-token",
        token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      input,
    });

    expect(result.success).toBe(true);
    expect(tool.method).toBe("POST");
    expect(new URL(requestUrl).search).toBe("");
    expect(requestInit?.method).toBe("POST");
    expect(JSON.parse(String(requestInit?.body))).toEqual(input);
  });

  test("rejects CJ failures returned inside HTTP 200 responses", async () => {
    const app = getAppTemplate("cjdropshipping");
    const tool = app?.tools.find(({ name }) => name === "shipping_calculate");
    if (!app || !tool) throw new Error("Missing CJ shipping_calculate tool");

    globalThis.fetch = async () => Response.json({
      code: 16900202,
      result: false,
      success: false,
      message: "Request method 'GET' not supported.",
      data: null,
    });

    const result = await executeTool({
      app,
      tool,
      credentials: {
        access_token: "cj-shipping-error-test-token",
        token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      input: {
        startCountryCode: "CN",
        endCountryCode: "US",
        zip: "10001",
        products: [{ vid: "cj-variant-1", quantity: 1 }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      error: "upstream_api_error",
      code: 16900202,
      message: "Request method 'GET' not supported.",
      failed_flag: "success",
    });
  });
});
