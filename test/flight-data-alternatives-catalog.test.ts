import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function app(slug: string) {
  const found = getAppTemplate(slug);
  if (!found) throw new Error(`Missing integration: ${slug}`);
  return found;
}

function requestRecorder(responseBody: unknown = { data: [] }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("affordable flight-data integration catalogs", () => {
  test("loads broad, route-bound provider coverage", () => {
    const expectedCounts: Record<string, number> = {
      airlabs: 17,
      aerodatabox: 41,
      "flightaware-aeroapi": 58,
      flightapi: 8,
    };

    for (const [slug, expectedCount] of Object.entries(expectedCounts)) {
      const provider = app(slug);
      expect(provider.tools).toHaveLength(expectedCount);
      expect(new Set(provider.tools.map((tool) => tool.name)).size).toBe(
        provider.tools.length,
      );
      const routes = provider.tools.map((tool) => `${tool.method} ${tool.path}`);
      expect(new Set(routes).size).toBe(routes.length);

      for (const tool of provider.tools) {
        const route = tool.path.replace(/\{\{[^}]+\}\}/g, "");
        const pathParameters = [...route.matchAll(/\{([^{}]+)\}/g)].map(
          (match) => match[1],
        );
        for (const parameter of pathParameters) {
          expect(tool.input_schema.properties?.[parameter]).toBeDefined();
          expect(tool.input_schema.required).toContain(parameter);
        }
      }
    }
  });

  test("uses each provider's documented API-key location", () => {
    expect(app("airlabs").auth.query_params).toEqual({
      api_key: "{{api_key}}",
    });
    expect(app("aerodatabox").auth.headers).toMatchObject({
      "X-Api-Key": "{{api_key}}",
    });
    expect(app("flightaware-aeroapi").auth.headers).toMatchObject({
      "x-apikey": "{{api_key}}",
    });
    expect(app("flightapi").tools.find((tool) => tool.name === "track_flight")!
      .path).toBe("/airline/{{credential.api_key}}");
  });

  test("calls AirLabs flight status with compact field selection support", async () => {
    const provider = app("airlabs");
    const tool = provider.tools.find(
      (item) => item.name === "get_flight_status",
    )!;
    const calls = requestRecorder({ response: { status: "active" } });

    await executeTool({
      app: provider,
      tool,
      credentials: { fields: { api_key: "airlabs-key" } },
      input: { flight_iata: "BA117" },
    });

    const request = new URL(calls[0].url);
    expect(`${request.origin}${request.pathname}`).toBe(
      "https://airlabs.co/api/v9/flight",
    );
    expect(request.searchParams.get("api_key")).toBe("airlabs-key");
    expect(request.searchParams.get("flight_iata")).toBe("BA117");
  });

  test("calls AeroDataBox dated status with path fields and header auth", async () => {
    const provider = app("aerodatabox");
    const tool = provider.tools.find(
      (item) => item.name === "get_flight_status",
    )!;
    const calls = requestRecorder([]);

    await executeTool({
      app: provider,
      tool,
      credentials: { fields: { api_key: "aerodatabox-key" } },
      input: {
        searchBy: "Number",
        searchParam: "BA117",
        dateLocal: "2026-08-01",
        withLocation: true,
      },
    });

    const request = new URL(calls[0].url);
    expect(`${request.origin}${request.pathname}`).toBe(
      "https://api.aerodatabox.com/flights/Number/BA117/2026-08-01",
    );
    expect(request.searchParams.get("withLocation")).toBe("true");
    expect(calls[0].init.headers).toMatchObject({
      "X-Api-Key": "aerodatabox-key",
    });
  });

  test("calls FlightAware status with bounded result pages and header auth", async () => {
    const provider = app("flightaware-aeroapi");
    const tool = provider.tools.find((item) => item.name === "get_flight")!;
    const calls = requestRecorder({ flights: [] });

    await executeTool({
      app: provider,
      tool,
      credentials: { fields: { api_key: "aeroapi-key" } },
      input: {
        ident: "BAW117",
        ident_type: "designator",
        start: "2026-08-01",
        end: "2026-08-02",
        max_pages: 1,
      },
    });

    const request = new URL(calls[0].url);
    expect(`${request.origin}${request.pathname}`).toBe(
      "https://aeroapi.flightaware.com/aeroapi/flights/BAW117",
    );
    expect(request.searchParams.get("ident_type")).toBe("designator");
    expect(request.searchParams.get("max_pages")).toBe("1");
    expect(calls[0].init.headers).toMatchObject({
      "x-apikey": "aeroapi-key",
    });
  });

  test("uses FlightAPI's documented key path and status query", async () => {
    const provider = app("flightapi");
    const tool = provider.tools.find((item) => item.name === "track_flight")!;
    const calls = requestRecorder([]);

    await executeTool({
      app: provider,
      tool,
      credentials: { fields: { api_key: "flightapi-key" } },
      input: {
        num: "117",
        name: "BA",
        date: "20260801",
        depap: "LHR",
      },
    });

    const request = new URL(calls[0].url);
    expect(`${request.origin}${request.pathname}`).toBe(
      "https://api.flightapi.io/airline/flightapi-key",
    );
    expect(request.searchParams.get("num")).toBe("117");
    expect(request.searchParams.get("name")).toBe("BA");
    expect(request.searchParams.get("date")).toBe("20260801");
    expect(request.searchParams.get("depap")).toBe("LHR");
  });

  test("keeps native alert operations typed and route fields out of bodies", async () => {
    const aerodatabox = app("aerodatabox");
    const subscribe = aerodatabox.tools.find(
      (item) => item.name === "subscribe_webhook",
    )!;
    const subscriptionCalls = requestRecorder({ id: "subscription-id" });

    await executeTool({
      app: aerodatabox,
      tool: subscribe,
      credentials: { fields: { api_key: "aerodatabox-key" } },
      input: {
        subjectType: "FlightByNumber",
        subjectId: "BA117",
        url: "https://example.com/flight-events",
        maxDeliveryRetries: 1,
      },
    });

    expect(JSON.parse(String(subscriptionCalls[0].init.body))).toEqual({
      url: "https://example.com/flight-events",
      maxDeliveryRetries: 1,
    });

    const flightaware = app("flightaware-aeroapi");
    const setEndpoint = flightaware.tools.find(
      (item) => item.name === "set_alerts_endpoint",
    )!;
    const alertCalls = requestRecorder({ url: "https://example.com/alerts" });

    await executeTool({
      app: flightaware,
      tool: setEndpoint,
      credentials: { fields: { api_key: "aeroapi-key" } },
      input: { url: "https://example.com/alerts" },
    });

    expect(JSON.parse(String(alertCalls[0].init.body))).toEqual({
      url: "https://example.com/alerts",
    });
    expect(
      flightaware.tools.find((item) => item.name === "create_alert")!
        .input_schema.properties?.id,
    ).toBeUndefined();
  });
});
