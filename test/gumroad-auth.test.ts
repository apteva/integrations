import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { ConnectionCredentials } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAppCache();
});

describe("Gumroad authentication", () => {
  test("uses a top-level token from a local server credential blob", async () => {
    const app = getAppTemplate("gumroad");
    const tool = app?.tools.find(({ name }) => name === "get_user");
    if (!app || !tool) throw new Error("Missing Gumroad get_user tool");

    let authorization = "";
    globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization") || "";
      return Response.json({ success: true, user: { id: "user-1" } });
    };

    // Local Go connections store catalog-defined fields directly in the
    // decrypted credential object, not under the optional `fields` wrapper.
    const credentials = { token: "gumroad-test-token" } as ConnectionCredentials;
    const result = await executeTool({ app, tool, credentials, input: {} });

    expect(result.success).toBe(true);
    expect(authorization).toBe("Bearer gumroad-test-token");
  });

  test("form-encodes product writes expected by Gumroad", async () => {
    const app = getAppTemplate("gumroad");
    const tool = app?.tools.find(({ name }) => name === "create_product");
    if (!app || !tool) throw new Error("Missing Gumroad create_product tool");

    let contentType = "";
    let body = "";
    globalThis.fetch = async (_url, init) => {
      contentType = new Headers(init?.headers).get("Content-Type") || "";
      body = String(init?.body || "");
      return Response.json({ success: true, product: { id: "product-1" } });
    };

    const result = await executeTool({
      app,
      tool,
      credentials: { token: "gumroad-test-token" },
      input: {
        name: "Integration Test",
        price: 100,
        published: false,
        tags: ["test", "temporary"],
      },
    });

    const form = new URLSearchParams(body);
    expect(result.success).toBe(true);
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect(form.get("name")).toBe("Integration Test");
    expect(form.get("price")).toBe("100");
    expect(form.get("published")).toBe("false");
    expect(form.getAll("tags")).toEqual(["test", "temporary"]);
  });

  test("uses Gumroad's typed resource-subscription contract", () => {
    const app = getAppTemplate("gumroad");
    if (!app) throw new Error("Missing Gumroad integration");
    const list = app.tools.find(({ name }) => name === "list_resource_subscriptions");
    const create = app.tools.find(({ name }) => name === "create_resource_subscription");
    if (!list || !create) throw new Error("Missing Gumroad resource-subscription tools");

    expect(list.query_params).toEqual(["resource_name"]);
    expect(list.input_schema.required).toEqual(["resource_name"]);
    expect(create.method).toBe("PUT");
    expect(create.input_schema.required).toEqual(["resource_name", "post_url"]);
  });

  test("matches Gumroad's current audience-email routes", () => {
    const app = getAppTemplate("gumroad");
    if (!app) throw new Error("Missing Gumroad integration");

    const list = app.tools.find(({ name }) => name === "list_emails");
    const create = app.tools.find(({ name }) => name === "create_email");
    const schedule = app.tools.find(({ name }) => name === "schedule_email");
    const unschedule = app.tools.find(({ name }) => name === "unschedule_email");

    expect(app.tools.some(({ name }) => name === "update_email")).toBe(false);
    expect(list?.query_params).toEqual(["type", "page_key"]);
    expect(create?.input_schema.required).toEqual(["subject", "body"]);
    expect(schedule?.method).toBe("POST");
    expect(schedule?.path).toBe("/emails/{emailId}/schedule");
    expect(schedule?.input_schema.required).toEqual(["emailId", "to_be_published_at"]);
    expect(unschedule?.method).toBe("POST");
    expect(unschedule?.path).toBe("/emails/{emailId}/unschedule");
  });
});
