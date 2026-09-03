import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function app(slug: string): AppTemplate {
  const value = getAppTemplate(slug);
  if (!value) throw new Error(`Missing search-provider integration: ${slug}`);
  return value;
}

function tool(slug: string, name: string): AppToolTemplate {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug} tool: ${name}`);
  return value;
}

describe("SearchApi and SerpApi catalogs", () => {
  test("load complete, unique toolsets with valid path schemas", () => {
    const expectedCounts: Record<string, number> = { searchapi: 15, serpapi: 11 };

    for (const [slug, count] of Object.entries(expectedCounts)) {
      const catalog = app(slug);
      expect(catalog.tools).toHaveLength(count);
      expect(new Set(catalog.tools.map(({ name }) => name)).size).toBe(count);
      expect(
        new Set(
          catalog.tools.map(
            ({ method, base_url, path }) =>
              `${method} ${base_url || catalog.base_url}${path}`,
          ),
        ).size,
      ).toBe(count);

      for (const candidate of catalog.tools) {
        for (const match of candidate.path.matchAll(/\{([^}]+)\}/g)) {
          const parameter = match[1];
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
          expect(candidate.input_schema.required).toContain(parameter);
        }
      }
    }
  });

  test("keeps source catalogs byte-identical to server mirrors", () => {
    for (const slug of ["searchapi", "serpapi"]) {
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url));
      const mirror = readFileSync(
        new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url),
      );
      expect(mirror.equals(source)).toBe(true);
    }
  });

  test("injects SerpApi credentials and supports engine-specific parameters", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ organic_results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("serpapi"),
      tool: tool("serpapi", "apple_app_store_search"),
      credentials: { api_key: "serp-secret" },
      input: { term: "photo editor", country: "fr", device: "mobile" },
    });

    const url = new URL(captured?.url || "https://invalid.test");
    expect(url.searchParams.get("engine")).toBe("apple_app_store");
    expect(url.searchParams.get("api_key")).toBe("serp-secret");
    expect(url.searchParams.get("term")).toBe("photo editor");
    expect(tool("serpapi", "search").input_schema.required).toEqual(["engine"]);
    for (const candidate of app("serpapi").tools) {
      expect(candidate.input_schema.properties?.api_key).toBeUndefined();
    }
  });

  test("uses SearchApi bearer auth for Meta searches", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ ads: [], pagination: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("searchapi"),
      tool: tool("searchapi", "meta_ad_library_search"),
      credentials: { api_key: "searchapi-secret" },
      input: {
        q: "solar panels",
        country: "FR",
        active_status: "active",
        platforms: "facebook,instagram",
      },
    });

    const getUrl = new URL(calls[0].url);
    expect(getUrl.searchParams.get("engine")).toBe("meta_ad_library");
    expect(getUrl.searchParams.get("q")).toBe("solar panels");
    expect(getUrl.searchParams.get("platforms")).toBe("facebook,instagram");
    expect(getUrl.searchParams.has("api_key")).toBe(false);
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe(
      "Bearer searchapi-secret",
    );

    await executeTool({
      app: app("searchapi"),
      tool: tool("searchapi", "meta_ad_library_search_post"),
      credentials: { api_key: "searchapi-secret" },
      input: {
        engine: "meta_ad_library",
        q: "solar panels",
        next_page_token: "x".repeat(9000),
      },
    });

    expect(calls[1].url).toBe("https://www.searchapi.io/api/v1/search");
    expect(calls[1].init.method).toBe("POST");
    expect(new Headers(calls[1].init.headers).get("Authorization")).toBe(
      "Bearer searchapi-secret",
    );
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({
      engine: "meta_ad_library",
      q: "solar panels",
      next_page_token: "x".repeat(9000),
    });
  });

  test("covers active ad libraries and omits SearchApi's deprecated Reddit source", () => {
    for (const name of [
      "meta_ad_library_search",
      "meta_ad_library_page_search",
      "meta_ad_library_page_info",
      "meta_ad_library_ad_details",
      "linkedin_ad_library_search",
      "tiktok_advertiser_search",
      "tiktok_ad_library_search",
      "tiktok_ad_details",
    ]) {
      expect(tool("searchapi", name)).toBeDefined();
    }
    expect(app("searchapi").tools.some(({ name }) => name.includes("reddit"))).toBe(false);
  });
});
