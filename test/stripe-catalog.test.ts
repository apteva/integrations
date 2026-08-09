import { describe, expect, test } from "bun:test";
import stripe from "../src/apps/stripe.json";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

describe("Stripe integration catalog", () => {
  test("declares platform-managed webhook registration with the returned signing secret", () => {
    expect(stripe.webhooks.registration).toMatchObject({
      method: "POST",
      path: "/webhook_endpoints",
      url_field: "url",
      events_field: "enabled_events[]",
      id_field: "id",
      response_secret_field: "secret",
      delete_path: "/webhook_endpoints/{id}",
      delete_method: "DELETE",
    });
    expect(stripe.tools.some((tool) => tool.name === "process_webhook")).toBe(false);
  });

  test("uses Stripe's real payment-method resource routes", () => {
    const get = stripe.tools.find((tool) => tool.name === "get_payment_method");
    const detach = stripe.tools.find((tool) => tool.name === "detach_payment_method");
    expect(get).toMatchObject({
      method: "GET",
      path: "/payment_methods/{payment_method_id}",
    });
    expect(detach).toMatchObject({
      method: "POST",
      path: "/payment_methods/{payment_method_id}/detach",
    });
  });

  test("pins Checkout creation to the Stripe version that supports Elements", () => {
    const checkout = stripe.tools.find((tool) => tool.name === "create_checkout_session");
    const uiMode = checkout?.input_schema?.properties?.ui_mode;
    expect(checkout?.headers).toEqual({
      "Stripe-Version": "2026-03-25.dahlia",
    });
    expect(uiMode?.default).toBe("hosted_page");
    expect(uiMode?.enum).toEqual(["hosted_page", "elements", "embedded_page"]);
  });

  test("sends the pinned version and nested Stripe form fields", async () => {
    const checkout = stripe.tools.find((tool) => tool.name === "create_checkout_session");
    expect(checkout).toBeDefined();

    let captured: { headers?: HeadersInit; body?: BodyInit | null } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured = { headers: init?.headers, body: init?.body };
      return new Response(JSON.stringify({ id: "cs_test_123", client_secret: "secret" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: stripe as AppTemplate,
        tool: checkout as AppToolTemplate,
        credentials: { access_token: "sk_test_example" },
        input: {
          mode: "payment",
          ui_mode: "elements",
          return_url: "https://example.com/return",
          line_items: [
            {
              price_data: {
                currency: "eur",
                product_data: { name: "Starter" },
                unit_amount: 1000,
              },
              quantity: 1,
            },
          ],
          metadata: { apteva_invoice_id: "123" },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured.headers).toMatchObject({
      Authorization: "Bearer sk_test_example",
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2026-03-25.dahlia",
    });
    const body = new URLSearchParams(String(captured.body));
    expect(body.get("ui_mode")).toBe("elements");
    expect(body.get("line_items[0][price_data][currency]")).toBe("eur");
    expect(body.get("line_items[0][price_data][product_data][name]")).toBe("Starter");
    expect(body.get("metadata[apteva_invoice_id]")).toBe("123");
  });
});
