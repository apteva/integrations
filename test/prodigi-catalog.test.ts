import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const prodigi = getAppTemplate("prodigi");
if (!prodigi) throw new Error("Missing Prodigi integration catalog");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Prodigi catalog definition", () => {
  test("defaults to the sandbox and authenticates with X-API-Key", () => {
    expect(prodigi.base_url).toBe("https://{{credential.api_host}}");
    expect(prodigi.auth.headers["X-API-Key"]).toBe("{{api_key}}");

    const environment = prodigi.auth.credential_fields.find(
      (field) => field.name === "api_host",
    );
    expect(environment?.default).toBe("api.sandbox.prodigi.com");
    expect(environment?.options).toEqual([
      "api.sandbox.prodigi.com",
      "api.prodigi.com",
    ]);
  });

  test("exposes the Commerce fulfillment surface", () => {
    const tools = Object.fromEntries(prodigi.tools.map((tool) => [tool.name, tool]));
    expect(tools.get_product.path).toBe("/v4.0/products/{sku}");
    expect(tools.create_quote.path).toBe("/v4.0/quotes");
    expect(tools.create_order.path).toBe("/v4.0/orders");
    expect(tools.get_order.path).toBe("/v4.0/orders/{order_id}");
    expect(tools.cancel_order.path).toBe(
      "/v4.0/orders/{order_id}/actions/cancel",
    );
    expect(tools.update_shipping_method.path).toBe(
      "/v4.0/orders/{order_id}/actions/updateShippingMethod",
    );
    expect(tools.update_recipient.path).toBe(
      "/v4.0/orders/{order_id}/actions/updateRecipient",
    );
    expect(tools.update_metadata.path).toBe(
      "/v4.0/orders/{order_id}/actions/updateMetadata",
    );
  });

  test("routes a quote to the selected environment without leaking credentials", async () => {
    const tool = prodigi.tools.find((candidate) => candidate.name === "create_quote");
    if (!tool) throw new Error("Missing Prodigi create_quote tool");
    let captured: { url: string; init?: RequestInit } | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ outcome: "Created", quotes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await executeTool({
      app: prodigi,
      tool,
      credentials: {
        fields: {
          api_key: "sandbox-secret",
          api_host: "api.sandbox.prodigi.com",
        },
      },
      input: {
        destinationCountryCode: "ES",
        currencyCode: "EUR",
        shippingMethod: "Budget",
        items: [{ sku: "GLOBAL-CAN-10X10", copies: 1, assets: [{ printArea: "default" }] }],
      },
    });

    expect(result.success).toBe(true);
    expect(captured?.url).toBe("https://api.sandbox.prodigi.com/v4.0/quotes");
    expect(new Headers(captured?.init?.headers).get("X-API-Key")).toBe(
      "sandbox-secret",
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      destinationCountryCode: "ES",
      currencyCode: "EUR",
      shippingMethod: "Budget",
      items: [{ sku: "GLOBAL-CAN-10X10", copies: 1, assets: [{ printArea: "default" }] }],
    });
  });
});
