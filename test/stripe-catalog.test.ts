import { describe, expect, test } from "bun:test";
import stripe from "../src/apps/stripe.json";

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
});
