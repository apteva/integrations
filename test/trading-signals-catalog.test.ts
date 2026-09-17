import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import { generateMcpServer } from "../src/mcp-generator.js";
import type { Connection } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("catalogs match bundled copies and use safe names", () => {
  for (const slug of ["unusual-whales", "trendspider", "altfins"]) {
    const app = getAppTemplate(slug)!;
    expect(app.name).not.toContain(".");
    expect(readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url), "utf8"))
      .toBe(readFileSync(new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url), "utf8"));
    for (const tool of app.tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(JSON.stringify(tool.input_schema)).not.toContain('"$ref"');
    }
  }
});

const routes = [
  ["list_flow_alerts", "/api/option-trades/flow-alerts"],
  ["list_darkpool_trades", "/api/darkpool/recent"],
  ["get_ticker_darkpool_trades", "/api/darkpool/AAPL"],
  ["get_market_tide", "/api/market/market-tide"],
  ["list_news_headlines", "/api/news/headlines"],
  ["list_alerts", "/api/alerts"],
  ["get_stock_info", "/api/stock/AAPL/info"],
];
for (const [name, path] of routes) {
  test(`Unusual Whales ${name} uses documented route and bearer auth`, async () => {
    const app = getAppTemplate("unusual-whales")!;
    const tool = app.tools.find(t => t.name === name)!;
    let captured = "";
    let headers = new Headers();
    globalThis.fetch = (async (url, init) => {
      captured = String(url); headers = new Headers(init?.headers);
      return Response.json({ data: [{ id: "alert-1" }], next: "cursor" });
    }) as typeof fetch;
    const input = tool.path.includes("{ticker}") ? { ticker: "AAPL" } : name === "list_flow_alerts"
      ? { ticker_symbol: "AAPL", all_opening: false, "rule_name[]": ["RepeatedHits", "RepeatedHitsAscendingFill"], limit: 10 } : {};
    const result = await executeTool({ app, tool, credentials: { fields: { token: "test-token" } }, input });
    const url = new URL(captured);
    expect(url.origin + url.pathname).toBe("https://api.unusualwhales.com" + path);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(url.searchParams.has("token")).toBe(false);
    if (name === "list_flow_alerts") {
      expect(url.searchParams.get("all_opening")).toBe("false");
      expect(url.searchParams.getAll("rule_name[]")).toEqual(["RepeatedHits", "RepeatedHitsAscendingFill"]);
    }
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ data: [{ id: "alert-1" }], next: "cursor" });
  });
}

for (const action of ["grant", "revoke"]) {
  test(`TrendSpider ${action} scopes credentials to a shared item and sends only email`, async () => {
    const app = getAppTemplate("trendspider")!;
    const tool = app.tools.find(t => t.name === `${action}_access`)!;
    let captured = "";
    let body: unknown;
    globalThis.fetch = (async (url, init) => {
      captured = String(url); body = JSON.parse(String(init?.body));
      expect(init?.method).toBe("POST");
      return Response.json(action === "grant" ? { success: true } : { success: false, error: "wrong_secret_key" });
    }) as typeof fetch;
    const result = await executeTool({ app, tool, credentials: { fields: { item_id: "item-123", secret_key: "test/key" } }, input: { email: "test@example.com" } });
    expect(captured).toBe(`https://charts.trendspider.com/shared_entities/public/1/access/item-123/test%2Fkey/${action}`);
    expect(body).toEqual({ email: "test@example.com" });
    expect(result.success).toBe(action === "grant");
    if (action === "revoke") expect(result.data).toMatchObject({ error: "upstream_api_error", message: "wrong_secret_key" });
  });
}

test("altFINS generates the official remote MCP connection with X-API-Key", () => {
  const app = getAppTemplate("altfins")!;
  const connection: Connection = {
    id: "signals", app_slug: app.slug, app_name: app.name, name: "altFINS",
    auth_type: "api_key", credentials: { fields: { api_key: "test-alt-key" } },
    status: "active", project_id: null, created_at: "2026-09-14", updated_at: "2026-09-14",
  };
  const generated = generateMcpServer(connection, app);
  expect(generated.name).toBe("altfins-signals");
  expect(generated.type).toBe("remote");
  expect(generated.tools).toEqual([]);
  expect(generated.remote).toEqual({ transport: "http", url: "https://mcp.altfins.com/mcp", headers: { "X-API-Key": "test-alt-key" } });
});
