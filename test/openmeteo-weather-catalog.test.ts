import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const variables of [undefined, ["precipitation", "cloud_cover"]]) {
  test(`OpenMeteo builds an unauthenticated current-weather request (${variables ? "extra variables" : "defaults"})`, async () => {
    const app = getAppTemplate("openmeteo-weather")!;
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ current: { temperature_2m: 20 } });
    }) as typeof fetch;
    const result = await executeTool({
      app, tool: app.tools[0], credentials: { fields: {} },
      input: { latitude: 40.42, longitude: -3.7, ...(variables ? { variables } : {}) },
    });
    const url = new URL(capturedUrl);
    expect(result.success).toBe(true);
    expect(app.auth.types).toEqual(["none"]);
    expect(app.auth.credential_fields).toEqual([]);
    expect(capturedHeaders.has("Authorization")).toBe(false);
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("40.42");
    expect(url.searchParams.get("longitude")).toBe("-3.7");
    expect(url.searchParams.has("variables")).toBe(false);
    expect(url.searchParams.getAll("current")).toEqual([
      "temperature_2m,relative_humidity_2m,wind_speed_10m,pressure_msl", ...(variables || []),
    ]);
  });
}
