import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

function app() {
  const result = getAppTemplate("yepapi");
  if (!result) throw new Error("Missing YepAPI integration");
  return result;
}

function tool(name: string) {
  const result = app().tools.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing YepAPI tool: ${name}`);
  return result;
}

describe("YepAPI integration catalog", () => {
  test("covers the current public API with unique route-bound typed tools", () => {
    const catalog = app();
    expect(catalog.tools).toHaveLength(154);
    expect(new Set(catalog.tools.map(({ name }) => name)).size).toBe(catalog.tools.length);
    expect(new Set(catalog.tools.map(({ method, path }) => `${method} ${path}`)).size).toBe(
      catalog.tools.length,
    );
    expect(catalog.tools.some(({ path }) => path === "/v1/serp")).toBe(false);

    for (const candidate of catalog.tools) {
      expect(candidate.description.length).toBeGreaterThan(20);
      expect(candidate.input_schema.properties?.body).toBeUndefined();
      const pathParameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const parameter of pathParameters) {
        expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        expect(candidate.input_schema.required).toContain(parameter);
      }
    }
  });

  test("covers every advertised product family", () => {
    for (const prefix of [
      "/v1/seo/",
      "/v1/serp/",
      "/v1/maps/",
      "/v1/scrape",
      "/v1/ai/",
      "/v1/media/",
      "/v1/youtube/",
      "/v1/tiktok/",
      "/v1/instagram/",
      "/v1/amazon/",
      "/v1/email/",
    ]) {
      expect(app().tools.some(({ path }) => path.startsWith(prefix))).toBe(true);
    }

    expect(tool("media_queue").input_schema.required).toEqual(["model"]);
    expect(tool("media_status")).toMatchObject({
      method: "GET",
      path: "/v1/media/status/{jobId}",
    });
    expect(tool("seo_keywords").input_schema.properties).toHaveProperty("filters");
    expect(tool("ai_chat_completions").input_schema.required).toEqual([
      "model",
      "messages",
    ]);
  });

  test("sends a typed paid request with x-api-key authentication", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      capturedBody = String(init?.body || "");
      return new Response(JSON.stringify({ ok: true, data: [{ keyword: "seo api" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: app(),
        tool: tool("seo_keywords"),
        credentials: { api_key: "yep_sk_test" },
        input: {
          keywords: ["seo api"],
          location_code: 2724,
          language: "es",
          filters: [{ field: "volume", op: ">=", value: 100 }],
          match: "all",
          sort: ["volume:desc"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedUrl).toBe("https://api.yepapi.com/v1/seo/keywords");
    expect(capturedHeaders).toMatchObject({
      "x-api-key": "yep_sk_test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(capturedBody)).toEqual({
      keywords: ["seo api"],
      location_code: 2724,
      language: "es",
      filters: [{ field: "volume", op: ">=", value: 100 }],
      match: "all",
      sort: ["volume:desc"],
    });
  });

  test("does not send credentials to the free model-discovery endpoint", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: app(),
        tool: tool("ai_models"),
        credentials: { api_key: "yep_sk_test" },
        input: {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedHeaders).not.toHaveProperty("x-api-key");
  });
});
