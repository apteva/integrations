import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const cases = [
  ["openweathermap", "get_current_weather", "/data/2.5/weather", { lat: 0, lon: -3.7, units: "metric", lang: "es" }, { cod: 200, main: { temp: 20 } }],
  ["openweathermap", "get_forecast", "/data/2.5/forecast", { lat: 40.42, lon: -3.7, units: "imperial", cnt: 8 }, { cod: "200", city: { name: "Madrid" }, list: [{ dt: 1 }] }],
  ["openweathermap", "geocode_location", "/geo/1.0/direct", { q: "São Paulo,BR", limit: 5 }, [{ name: "São Paulo", lat: -23.55, lon: -46.63 }]],
  ["openweathermap", "reverse_geocode", "/geo/1.0/reverse", { lat: 0, lon: 0, limit: 1 }, []],
  ["openweathermap", "geocode_postcode", "/geo/1.0/zip", { zip: "75001,FR" }, { zip: "75001", lat: 48.86, lon: 2.34 }],
  ["weatherapi", "get_current_weather", "/v1/current.json", { q: "40.42,-3.7", lang: "es" }, { location: { name: "Madrid" }, current: { temp_c: 20 } }],
  ["weatherapi", "get_forecast", "/v1/forecast.json", { q: "id:2801268", days: 3 }, { location: { name: "London" }, forecast: { forecastday: [{ date: "2026-09-13" }] } }],
  ["weatherapi", "search_locations", "/v1/search.json", { q: "São Paulo" }, [{ id: 123, name: "São Paulo" }]],
] as const;

for (const [slug, name, path, input, payload] of cases) {
  test(`${slug}.${name} sends provider query parameters and preserves response metadata`, async () => {
    const app = getAppTemplate(slug)!;
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init || {};
      return Response.json(payload);
    }) as typeof fetch;
    const tool = app.tools.find(t => t.name === name)!;
    const result = await executeTool({ app, tool, credentials: { fields: { api_key: "test+key&value" } }, input });
    const url = new URL(capturedUrl);
    expect(url.origin).toBe(slug === "openweathermap" ? "https://api.openweathermap.org" : "https://api.weatherapi.com");
    expect(url.pathname).toBe(path);
    const authParam = slug === "openweathermap" ? "appid" : "key";
    expect(url.searchParams.getAll(authParam)).toEqual(["test+key&value"]);
    expect([...url.searchParams.keys()].sort()).toEqual([authParam, ...Object.keys(input)].sort());
    for (const [key, value] of Object.entries(input)) expect(url.searchParams.get(key)).toBe(String(value));
    expect(new Headers(capturedInit.headers).has("Authorization")).toBe(false);
    expect(capturedInit.method).toBe("GET");
    expect(capturedInit.body).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(payload);
  });
}

test("forecast inputs match provider semantics and free-plan limits", () => {
  const ow = getAppTemplate("openweathermap")!;
  const wa = getAppTemplate("weatherapi")!;
  expect(ow.tools).toHaveLength(5);
  expect(wa.tools).toHaveLength(3);
  const owForecast = ow.tools.find(t => t.name === "get_forecast")!;
  const waForecast = wa.tools.find(t => t.name === "get_forecast")!;
  expect(owForecast.input_schema.required).toEqual(["lat", "lon"]);
  expect(owForecast.input_schema.properties).toMatchObject({ cnt: { maximum: 40 } });
  expect(waForecast.input_schema.required).toEqual(["q", "days"]);
  expect(waForecast.input_schema.properties).toMatchObject({ days: { minimum: 1, maximum: 3 } });
  for (const app of [ow, wa]) {
    expect(app.auth.types).toEqual(["api_key"]);
    expect(app.auth.credential_fields).toHaveLength(1);
    expect(app.auth.credential_fields![0]).toMatchObject({ name: "api_key", type: "password", required: true });
    expect(app.tools.every(t => !t.path.includes("onecall"))).toBe(true);
  }
});

for (const [slug, status, payload] of [
  ["openweathermap", 401, { cod: 401, message: "Invalid API key" }],
  ["weatherapi", 401, { error: { code: 2006, message: "API key provided is invalid" } }],
  ["weatherapi", 403, { error: { code: 2007, message: "API key has exceeded calls per month quota" } }],
] as const) {
  test(`${slug} preserves provider error status ${status}`, async () => {
    globalThis.fetch = (async () => Response.json(payload, { status })) as typeof fetch;
    const app = getAppTemplate(slug)!;
    const result = await executeTool({ app, tool: app.tools[0], credentials: { fields: { api_key: "invalid" } }, input: slug === "weatherapi" ? { q: "London" } : { lat: 0, lon: 0 } });
    expect(result.success).toBe(false);
    expect(result.status).toBe(status);
    expect(result.data).toEqual(payload);
  });
}
