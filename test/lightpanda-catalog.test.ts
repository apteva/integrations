import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Lightpanda integration catalog", () => {
  test("models the documented HTTP API without inventing CDP tools", () => {
    const app = getAppTemplate("lightpanda");
    if (!app) throw new Error("Missing Lightpanda integration catalog");

    expect(app.base_url).toBe("https://{{credential.region}}.cloud.lightpanda.io");
    expect(app.tools).toHaveLength(1);
    expect(app.tools[0]).toMatchObject({
      name: "fetch",
      method: "POST",
      path: "/api/fetch",
    });
    expect(app.tools[0].input_schema.properties).toMatchObject({
      url: { type: "string", format: "uri" },
      output_format: { enum: ["html", "markdown"] },
      wait_event: {
        enum: ["DOMContentLoaded", "load", "networkAlmostIdle", "networkIdle"],
      },
      proxy_name: { enum: ["fast_dc", "datacenter"] },
    });
  });

  test("sends bearer-authenticated JSON to the selected regional endpoint", async () => {
    const app = getAppTemplate("lightpanda")!;
    const tool = app.tools[0];
    let captured: { url: string; init?: RequestInit } | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({ data: "# Example", status: 200, headers: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await executeTool({
      app,
      tool,
      credentials: { fields: { token: "test-token", region: "uswest" } },
      input: {
        url: "https://example.com",
        output_format: "markdown",
        wait_ms: 2500,
        wait_event: "networkIdle",
        raw: false,
        proxy_name: "datacenter",
        country: "us",
      },
    });

    expect(result.success).toBe(true);
    expect(captured?.url).toBe("https://uswest.cloud.lightpanda.io/api/fetch");
    expect(new Headers(captured?.init?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    expect(new Headers(captured?.init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      url: "https://example.com",
      output_format: "markdown",
      wait_ms: 2500,
      wait_event: "networkIdle",
      raw: false,
      proxy_name: "datacenter",
      country: "us",
    });
  });
});
