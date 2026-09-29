import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Trading 212 checks account summary with API Key ID and API Secret", async () => {
  const app = getAppTemplate("trading212");
  expect(app).toBeDefined();
  if (!app) return;

  expect(app.auth.credential_fields?.filter((field) => field.required).map((field) => field.name))
    .toEqual(["api_key", "api_secret"]);
  expect(app.auth.headers?.Authorization).toBe("Basic {{basic_auth}}");
  expect(app.health_check).toEqual({ tool: "get_account_summary", input: {} });

  const tool = app.tools.find((item) => item.name === app.health_check?.tool);
  expect(tool).toMatchObject({ method: "GET", path: "/equity/account/summary" });
  if (!tool) return;

  let request: { url?: string; method?: string; authorization?: string } = {};
  globalThis.fetch = async (url, init) => {
    request = {
      url: String(url),
      method: init?.method,
      authorization: new Headers(init?.headers).get("Authorization") || "",
    };
    return new Response(JSON.stringify({ currencyCode: "EUR" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeTool({
    app,
    tool,
    credentials: { fields: { api_key: "key-id", api_secret: "secret-value" } },
    input: {},
  });

  expect(result.success).toBe(true);
  expect(request).toEqual({
    url: "https://live.trading212.com/api/v0/equity/account/summary",
    method: "GET",
    authorization: `Basic ${Buffer.from("key-id:secret-value").toString("base64")}`,
  });
});
