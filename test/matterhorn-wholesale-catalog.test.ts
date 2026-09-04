import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAppCache();
});

function matterhorn(): AppTemplate {
  const app = getAppTemplate("matterhorn-wholesale");
  if (!app) throw new Error("Missing Matterhorn Wholesale integration");
  return app;
}

function matterhornTool(name: string): AppToolTemplate {
  const tool = matterhorn().tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Matterhorn tool: ${name}`);
  return tool;
}

describe("Matterhorn Wholesale integration catalog", () => {
  test("covers the documented catalog, delivery, and order API", () => {
    const app = matterhorn();
    const names = app.tools.map(({ name }) => name);

    expect(names).toHaveLength(12);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      "categories_list",
      "brands_list",
      "currencies_list",
      "delivery_methods_list",
      "delivery_methods_by_country",
      "products_list",
      "inventory_list",
      "product_get",
      "product_get_by_ean",
      "orders_list",
      "order_get",
      "order_create",
    ]));
    expect(app.base_url).toBe("https://matterhorn-wholesale.com/B2BAPI");
    expect(app.auth.headers?.Authorization).toBe("{{api_key}}");
    expect(matterhornTool("order_create").method).toBe("PUT");
  });

  test("keeps the source catalog byte-identical to the server mirror", () => {
    const source = readFileSync(new URL("../src/apps/matterhorn-wholesale.json", import.meta.url));
    const mirror = readFileSync(new URL("../../server/integrations-catalog/matterhorn-wholesale.json", import.meta.url));
    expect(mirror.equals(source)).toBe(true);
  });

  test("serializes product synchronization filters as query parameters", async () => {
    let requestUrl = "";
    let requestHeaders = new Headers();
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestHeaders = new Headers(init?.headers);
      return Response.json([]);
    };

    const result = await executeTool({
      app: matterhorn(),
      tool: matterhornTool("products_list"),
      credentials: { api_key: "matterhorn-test-key" },
      input: {
        page: 2,
        brand_id: 428,
        category_id: 91,
        new_collection: 1,
        last_update: "2026-09-01 12:30:00",
        limit: 500,
      },
    });

    expect(result.success).toBe(true);
    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/B2BAPI/ITEMS/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: "2",
      brand_id: "428",
      category_id: "91",
      new_collection: "1",
      last_update: "2026-09-01 12:30:00",
      limit: "500",
    });
    expect(requestHeaders.get("Authorization")).toBe("matterhorn-test-key");
  });

  test("creates dropshipping orders with Matterhorn's PUT body", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return Response.json({ id: 12345, status: "New order" });
    };

    const order = {
      items: [{ variant_uid: 1090551, quantity: 2 }],
      delivery_to: {
        first_name: "Jane",
        second_name: "Smith",
        country: "US",
        street: "Main Street",
        house_number: "10",
        zip: "10001",
        city: "New York",
        phone: "+12125550100",
      },
      currency: "EUR",
      delivery_method_id: 160,
    };
    const result = await executeTool({
      app: matterhorn(),
      tool: matterhornTool("order_create"),
      credentials: { api_key: "matterhorn-order-test-key" },
      input: order,
    });

    expect(result.success).toBe(true);
    expect(new URL(requestUrl).pathname).toBe("/B2BAPI/ACCOUNT/ORDERS/");
    expect(requestInit?.method).toBe("PUT");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe("matterhorn-order-test-key");
    expect(JSON.parse(String(requestInit?.body))).toEqual(order);
  });
});
