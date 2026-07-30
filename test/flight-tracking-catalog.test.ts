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

describe("flight tracking integration catalogs", () => {
  test("loads all five providers with unique route-bound tools", () => {
    for (const slug of [
      "adsb-lol",
      "airplanes-live",
      "opensky",
      "aviationstack",
      "amadeus",
    ]) {
      const provider = app(slug);
      expect(provider.tools.length).toBeGreaterThan(5);
      expect(new Set(provider.tools.map((tool) => tool.name)).size).toBe(
        provider.tools.length,
      );
      const routes = provider.tools.map((tool) => `${tool.method} ${tool.path}`);
      expect(new Set(routes).size).toBe(routes.length);

      for (const tool of provider.tools) {
        const pathParameters = [...tool.path.matchAll(/\{([^}]+)\}/g)].map(
          (match) => match[1],
        );
        for (const parameter of pathParameters) {
          expect(tool.input_schema.properties?.[parameter]).toBeDefined();
          expect(tool.input_schema.required).toContain(parameter);
        }
      }
    }
  });

  test("models public ADS-B APIs without invented authentication", () => {
    expect(app("adsb-lol").auth.types).toEqual(["none"]);
    expect(app("airplanes-live").auth.types).toEqual(["none"]);
    expect(
      app("adsb-lol").tools.find((tool) => tool.name === "aircraft_near_point")!
        .path,
    ).toBe("/v2/point/{lat}/{lon}/{radius}");
    expect(
      app("airplanes-live").tools.find(
        (tool) => tool.name === "aircraft_near_point",
      )!.path,
    ).toBe("/point/{lat}/{lon}/{radius}");
  });

  test("exchanges OpenSky OAuth credentials and repeats ICAO filters", async () => {
    const provider = app("opensky");
    const tool = provider.tools.find((item) => item.name === "get_states")!;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (String(url).includes("/protocol/openid-connect/token")) {
        return new Response(
          JSON.stringify({ access_token: "opensky-token", expires_in: 1800 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ time: 1, states: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app: provider,
      tool,
      credentials: {
        fields: { client_id: "client", client_secret: "secret" },
      },
      input: { icao24: ["3c675a", "4ca87c"] },
    });

    expect(calls).toHaveLength(2);
    expect(String(calls[0].init.body)).toContain("grant_type=client_credentials");
    expect(calls[1].url).toContain("icao24=3c675a");
    expect(calls[1].url).toContain("icao24=4ca87c");
    expect(calls[1].init.headers).toMatchObject({
      Authorization: "Bearer opensky-token",
    });
  });

  test("uses Aviationstack access_key auth and narrow flight filters", async () => {
    const provider = app("aviationstack");
    const tool = provider.tools.find((item) => item.name === "list_flights")!;
    let requestUrl = "";
    globalThis.fetch = (async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({ pagination: {}, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app: provider,
      tool,
      credentials: { fields: { api_key: "aviation-key" } },
      input: { flight_iata: "IB532", limit: 1 },
    });

    const parsed = new URL(requestUrl);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://api.aviationstack.com/v1/flights",
    );
    expect(parsed.searchParams.get("access_key")).toBe("aviation-key");
    expect(parsed.searchParams.get("flight_iata")).toBe("IB532");
    expect(parsed.searchParams.get("limit")).toBe("1");
  });

  test("templates the Amadeus environment into OAuth and official status routes", async () => {
    const provider = app("amadeus");
    const tool = provider.tools.find((item) => item.name === "get_flight_status")!;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (String(url).endsWith("/v1/security/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "amadeus-token", expires_in: 1799 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app: provider,
      tool,
      credentials: {
        fields: {
          api_host: "test.api.amadeus.com",
          client_id: "amadeus-key",
          client_secret: "amadeus-secret",
        },
      },
      input: {
        carrierCode: "IB",
        flightNumber: "532",
        scheduledDepartureDate: "2026-08-01",
      },
    });

    expect(calls[0].url).toBe(
      "https://test.api.amadeus.com/v1/security/oauth2/token",
    );
    expect(String(calls[0].init.body)).toContain("client_id=amadeus-key");
    expect(calls[1].url).toBe(
      "https://test.api.amadeus.com/v2/schedule/flights?carrierCode=IB&flightNumber=532&scheduledDepartureDate=2026-08-01",
    );
    expect(calls[1].init.headers).toMatchObject({
      Authorization: "Bearer amadeus-token",
    });
  });

  test("removes the old Amadeus pseudo-routes", () => {
    const routes = new Set(app("amadeus").tools.map((tool) => tool.path));
    for (const oldPath of [
      "/flight-search",
      "/flight-inspiration",
      "/airport-search",
      "/hotel-search",
      "/hotel-booking",
    ]) {
      expect(routes.has(oldPath)).toBe(false);
    }
  });
});
