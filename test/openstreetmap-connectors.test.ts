import { afterEach, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor";
import overpass from "../src/apps/openstreetmap-overpass.json";
import nominatim from "../src/apps/openstreetmap-nominatim.json";
import type { AppTemplate, AppToolTemplate } from "../src/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Overpass restaurant search requests node, way and relation tags with an identifying User-Agent", async () => {
  let url = "";
  globalThis.fetch = (async (request, options) => {
    url = String(request);
    expect(new Headers(options?.headers).get("User-Agent")).toContain("ops@example.org");
    return Response.json({ elements: [{ type: "node", id: 123, tags: { email: "hi@example.org", website: "https://example.org" } }] });
  }) as typeof fetch;
  const result = await executeTool({
    app: overpass as AppTemplate,
    tool: overpass.tools[0] as AppToolTemplate,
    credentials: { fields: { contact_email: "ops@example.org" } },
    input: { lat: 40.42, lon: -3.70, radius: 500 },
  });
  expect(result.success).toBe(true);
  expect((result.data as any).elements[0].tags.website).toBe("https://example.org");
  expect(decodeURIComponent(new URL(url).searchParams.get("data")!)).toContain('nwr(around:500,40.42,-3.7)["amenity"="restaurant"]');
});

test("Nominatim requires an operator endpoint and preserves extra OSM tags", async () => {
  globalThis.fetch = (async (request) => {
    expect(String(request)).toContain("https://geo.example.org/search?");
    return Response.json([{ osm_id: 123, extratags: { "contact:email": "hi@example.org" } }]);
  }) as typeof fetch;
  const tool = nominatim.tools[0] as AppToolTemplate;
  const app = nominatim as AppTemplate;
  await expect(executeTool({ app, tool, credentials: { fields: { nominatim_base_url: "https://nominatim.openstreetmap.org" } }, input: { q: "Baba Nahm" } })).rejects.toThrow("public endpoint");
  const result = await executeTool({ app, tool, credentials: { fields: { nominatim_base_url: "https://geo.example.org" } }, input: { q: "Baba Nahm" } });
  expect((result.data as any)[0].extratags["contact:email"]).toBe("hi@example.org");
});
