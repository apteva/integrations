import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

// Public data sources that apps call by slug without a connection: the
// integration is keyless ("none"), or the tool is marked public.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function tool(slug: string, name: string) {
  const app = getAppTemplate(slug)!;
  const def = app.tools.find((t) => t.name === name);
  expect(def).toBeDefined();
  return { app, def: def! };
}

function keyless(slug: string, name: string): boolean {
  const { app, def } = tool(slug, name);
  return app.auth.types.includes("none") || def.public === true;
}

async function capture(slug: string, name: string, input: Record<string, unknown>) {
  const { app, def } = tool(slug, name);
  let url = "";
  let headers = new Headers();
  globalThis.fetch = (async (u, init) => {
    url = String(u);
    headers = new Headers(init?.headers);
    return Response.json({});
  }) as typeof fetch;
  const result = await executeTool({ app, tool: def, credentials: { fields: {} }, input });
  expect(result.success).toBe(true);
  return { url: new URL(url), headers };
}

test("intelligence's public sources are all keyless in the catalog", () => {
  for (const [slug, name] of [
    ["polymarket", "list_markets"], ["polymarket", "get_market"], ["polymarket", "list_events"],
    ["kalshi", "list_markets"], ["kalshi", "get_market"], ["kalshi", "get_event"], ["kalshi", "exchange_status"],
    ["manifold-markets", "search_markets"], ["manifold-markets", "list_markets"], ["manifold-markets", "get_market"],
    ["gdelt", "doc_search"], ["gdelt", "doc_timeline_volume"],
    ["bls", "get_series_single"], ["bls", "get_series"],
    ["wikipedia", "page_summary"], ["wikipedia", "search"],
    ["yahoo-finance", "stock_chart"], ["yahoo-finance", "stock_search"],
  ]) {
    expect(`${slug}.${name}:${keyless(slug, name)}`).toBe(`${slug}.${name}:true`);
  }
  // Trading stays behind credentials.
  expect(keyless("polymarket", "create_order")).toBe(false);
  expect(keyless("polymarket", "get_balance")).toBe(false);
});

test("Polymarket market window query is expressible and sends no credentials", async () => {
  const { url, headers } = await capture("polymarket", "list_markets", {
    closed: false, active: true, order: "volumeNum", ascending: false, limit: 200,
    end_date_min: "2026-11-21T00:00:00Z", end_date_max: "2026-12-01T00:00:00Z",
  });
  expect(url.origin + url.pathname).toBe("https://gamma-api.polymarket.com/markets");
  expect(url.searchParams.get("order")).toBe("volumeNum");
  expect(url.searchParams.get("end_date_min")).toBe("2026-11-21T00:00:00Z");
  expect(url.searchParams.get("end_date_max")).toBe("2026-12-01T00:00:00Z");
  expect(headers.get("Authorization") ?? "").not.toContain("{{");
});

test("Kalshi get_event and the multivariate filter", async () => {
  const ev = await capture("kalshi", "get_event", { event_ticker: "KXFED-26DEC" });
  expect(ev.url.pathname).toBe("/trade-api/v2/events/KXFED-26DEC");
  const list = await capture("kalshi", "list_markets", { status: "open", mve_filter: "exclude" });
  expect(list.url.searchParams.get("mve_filter")).toBe("exclude");
});

test("Manifold search accepts contractType", async () => {
  const { url } = await capture("manifold-markets", "search_markets", { term: "", contractType: "BINARY", sort: "24-hour-vol" });
  expect(url.searchParams.get("contractType")).toBe("BINARY");
});

test("GDELT tools are paced to its one-request-per-five-seconds limit", () => {
  for (const t of getAppTemplate("gdelt")!.tools) {
    expect(t.rate_limit?.min_interval_ms ?? 0).toBeGreaterThanOrEqual(5000);
    expect(t.rate_limit?.retry_statuses).toContain(429);
  }
});
