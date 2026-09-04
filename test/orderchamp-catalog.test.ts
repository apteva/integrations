import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function orderchamp(): AppTemplate {
  const app = getAppTemplate("orderchamp");
  if (!app) throw new Error("Missing Orderchamp integration");
  return app;
}

function tool(name: string): AppToolTemplate {
  const candidate = orderchamp().tools.find((value) => value.name === name);
  if (!candidate) throw new Error(`Missing Orderchamp tool: ${name}`);
  return candidate;
}

describe("Orderchamp integration catalog", () => {
  test("exposes typed dropshipping operations and keeps the raw escape hatch", () => {
    const names = orderchamp().tools.map(({ name }) => name);
    expect(names).toHaveLength(26);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      "list_publications",
      "get_inventory_by_sku",
      "set_inventory_by_sku",
      "bulk_adjust_inventory",
      "create_ingested_order",
      "get_retailer_order",
      "create_shipment",
      "mark_shipment_shipped",
      "create_webhook",
      "update_webhook",
      "delete_webhook",
      "graphql",
    ]));
    expect(tool("create_ingested_order").input_schema.required).toContain("is_test");
  });

  test("keeps the source catalog byte-identical to the server mirror", () => {
    const source = readFileSync(new URL("../src/apps/orderchamp.json", import.meta.url));
    const mirror = readFileSync(new URL("../../server/integrations-catalog/orderchamp.json", import.meta.url));
    expect(mirror.equals(source)).toBe(true);
  });

  test("builds safe typed GraphQL variables for inventory, orders, and shipments", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: orderchamp(),
      tool: tool("set_inventory_by_sku"),
      credentials: { token: "secret" },
      input: { sku: "SKU-1", quantity: 12, location_id: "location-1" },
    });
    await executeTool({
      app: orderchamp(),
      tool: tool("create_ingested_order"),
      credentials: { token: "secret" },
      input: {
        external_order_id: "shop-100",
        external_order_number: "#100",
        is_test: true,
        shipping_address: {
          street: "Main Street",
          postalCode: "1017PW",
          city: "Amsterdam",
          country: "NL",
        },
        products: [{ sku: "SKU-1", title: "Candle", quantity: 2 }],
      },
    });
    await executeTool({
      app: orderchamp(),
      tool: tool("create_shipment"),
      credentials: { token: "secret" },
      input: {
        order_id: "order-1",
        products: [{ id: "order-product-1", quantity: 2 }],
        external_shipment_id: "shipment-100",
      },
    });

    expect(bodies[0]).toMatchObject({
      operationName: "SetInventoryBySku",
      variables: {
        input: { action: "SET", sku: "SKU-1", adjustment: 12, locationId: "location-1" },
      },
    });
    expect(bodies[1]).toMatchObject({
      operationName: "CreateIngestedOrder",
      variables: {
        input: {
          externalOrderId: "shop-100",
          externalOrderNumber: "#100",
          isTest: true,
          products: [{ sku: "SKU-1", title: "Candle", quantity: 2 }],
        },
      },
    });
    expect(bodies[2]).toMatchObject({
      operationName: "CreateShipment",
      variables: {
        input: {
          orderId: "order-1",
          products: [{ id: "order-product-1", quantity: 2 }],
          externalShipmentId: "shipment-100",
        },
      },
    });
    for (const body of bodies) expect(body.query).toBeString();
  });
});
