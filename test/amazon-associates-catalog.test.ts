import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const amazon = getAppTemplate("amazon-associates");
if (!amazon) throw new Error("Missing Amazon Associates integration catalog");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Amazon Associates Creators API catalog", () => {
  test("collects durable Creators API credentials instead of an access token", () => {
    expect(amazon.auth.credential_fields?.map((field) => field.name)).toEqual([
      "credential_id",
      "credential_secret",
      "credential_version",
      "marketplace",
    ]);
    expect(amazon.auth.headers?.Authorization).toBe("Bearer {{access_token}}");
    expect(amazon.auth.credential_fields?.find((field) => field.name === "credential_version")).toMatchObject({
      required: false,
      default: "3.1",
    });
    expect(amazon.auth.credential_fields?.find((field) => field.name === "marketplace")).toMatchObject({
      required: false,
      default: "www.amazon.com",
    });
    expect(amazon.auth.token_exchange).toMatchObject({
      content_type: "application/json",
      body_params: {
        grant_type: "client_credentials",
        client_id: "{{credential.credential_id}}",
        client_secret: "{{credential.credential_secret}}",
        scope: "creatorsapi::default",
      },
      url_selector: {
        credential_field: "credential_version",
      },
    });
  });

  test("selects the token endpoint by credential version and caches the token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (String(url).endsWith("/auth/o2/token")) {
        return new Response(
          JSON.stringify({ access_token: "amazon-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ itemsResult: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const credentials = {
      fields: {
        credential_id: "creator-id",
        credential_secret: "creator-secret",
        credential_version: "3.2",
        marketplace: "www.amazon.co.uk",
      },
    };
    const tool = amazon.tools.find((candidate) => candidate.name === "items_search");
    if (!tool) throw new Error("Missing Amazon items_search tool");

    for (let i = 0; i < 2; i++) {
      await executeTool({
        app: amazon,
        tool,
        credentials,
        input: { partnerTag: "example-21", keywords: "laptop" },
      });
    }

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("https://api.amazon.co.uk/auth/o2/token");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "creator-id",
      client_secret: "creator-secret",
      scope: "creatorsapi::default",
    });
    expect(new Headers(calls[1].init.headers).get("Authorization")).toBe(
      "Bearer amazon-token",
    );
    expect(new Headers(calls[1].init.headers).get("x-marketplace")).toBe(
      "www.amazon.co.uk",
    );
  });

  test("applies North America defaults when version and marketplace are omitted", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (String(url).endsWith("/auth/o2/token")) {
        return new Response(
          JSON.stringify({ access_token: "default-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ itemsResult: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const credentials = {
      fields: {
        credential_id: "creator-id",
        credential_secret: "creator-secret",
      },
    };
    const tool = amazon.tools.find((candidate) => candidate.name === "items_search");
    if (!tool) throw new Error("Missing Amazon items_search tool");
    await executeTool({
      app: amazon,
      tool,
      credentials,
      input: { partnerTag: "example-20", keywords: "monitor" },
    });

    expect(calls[0].url).toBe("https://api.amazon.com/auth/o2/token");
    expect(new Headers(calls[1].init.headers).get("x-marketplace")).toBe(
      "www.amazon.com",
    );
    expect(credentials.fields).toMatchObject({
      credential_version: "3.1",
      marketplace: "www.amazon.com",
    });
  });
});
