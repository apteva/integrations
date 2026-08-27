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
  if (!value) throw new Error(`Missing app-intelligence integration: ${slug}`);
  return value;
}

function tool(slug: string, name: string): AppToolTemplate {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug} tool: ${name}`);
  return value;
}

describe("app intelligence integration catalogs", () => {
  test("load unique, route-bound toolsets with complete path schemas", () => {
    const expectedCounts: Record<string, number> = {
      "apple-app-store-charts": 1,
      "42matters": 10,
      apptweak: 8,
      appfigures: 7,
      "sensor-tower": 4,
    };

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
    for (const slug of [
      "apple-app-store-charts",
      "42matters",
      "apptweak",
      "appfigures",
      "sensor-tower",
    ]) {
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url));
      const mirror = readFileSync(
        new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url),
      );
      expect(mirror.equals(source)).toBe(true);
    }
  });

  test("models official charts separately from estimated grossing data", () => {
    const apple = app("apple-app-store-charts");
    expect(apple.auth.types).toEqual(["none"]);
    expect(tool("apple-app-store-charts", "get_top_apps").input_schema.properties?.chart.enum)
      .toEqual(["top-free", "top-paid"]);

    expect(tool("42matters", "get_ios_top_charts").input_schema.properties?.list_name.enum)
      .toContain("topgrossing");
    expect(tool("apptweak", "get_top_charts_current").input_schema.properties?.types.enum)
      .toContain("grossing");
    expect(tool("appfigures", "get_rank_snapshot").input_schema.properties?.subcategory.enum)
      .toContain("topgrossing");
  });

  test("exposes discovery, rank history, and estimates where supported", () => {
    expect(tool("42matters", "search_ios_apps").path).toBe("/ios/apps/search.json");
    expect(tool("42matters", "get_ios_download_estimates").base_url).toContain("v5.0");
    expect(tool("apptweak", "get_app_metrics_history").path).toBe(
      "/apps/metrics/history.json",
    );
    expect(tool("appfigures", "search_products").path).toBe(
      "/products/search/{term}",
    );
    expect(tool("sensor-tower", "get_sales_estimates").path).toBe(
      "/v1/{os}/sales_report_estimates",
    );
  });

  test("builds provider-specific authentication and query placement", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("apple-app-store-charts"),
      tool: tool("apple-app-store-charts", "get_top_apps"),
      credentials: {},
      input: { country: "us", chart: "top-free", limit: 10 },
    });
    expect(calls[0].url).toBe(
      "https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/10/apps.json",
    );

    await executeTool({
      app: app("42matters"),
      tool: tool("42matters", "get_ios_top_charts"),
      credentials: { api_key: "forty-two-token" },
      input: { list_name: "topgrossing", country: "US", limit: 25 },
    });
    expect(calls[1].url).toContain("/api/v3.0/ios/apps/top_appstore_charts.json?");
    expect(calls[1].url).toContain("access_token=forty-two-token");
    expect(calls[1].url).toContain("list_name=topgrossing");

    await executeTool({
      app: app("apptweak"),
      tool: tool("apptweak", "get_top_charts_current"),
      credentials: { api_key: "apptweak-token" },
      input: { categories: "6014", types: "grossing", country: "us", device: "iphone" },
    });
    expect(new Headers(calls[2].init.headers).get("x-apptweak-key")).toBe(
      "apptweak-token",
    );
    expect(calls[2].url).toContain("types=grossing");

    await executeTool({
      app: app("appfigures"),
      tool: tool("appfigures", "get_rank_snapshot"),
      credentials: { fields: { token: "appfigures-pat" } },
      input: {
        time: "current",
        country: "us",
        category: 14,
        subcategory: "topgrossing",
        count: 100,
      },
    });
    expect(new Headers(calls[3].init.headers).get("Authorization")).toBe(
      "Bearer appfigures-pat",
    );
    expect(calls[3].url).toContain("/ranks/snapshots/current/us/14/topgrossing");

    await executeTool({
      app: app("sensor-tower"),
      tool: tool("sensor-tower", "get_sales_estimates"),
      credentials: { api_key: "sensor-token" },
      input: {
        os: "ios",
        app_ids: "6448311069",
        countries: "US",
        start_date: "2026-08-01",
        end_date: "2026-08-25",
        date_granularity: "daily",
      },
    });
    expect(calls[4].url).toContain("/v1/ios/sales_report_estimates?");
    expect(calls[4].url).toContain("auth_token=sensor-token");
    expect(calls[4].url).toContain("app_ids=6448311069");
  });
});
