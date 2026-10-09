import { afterEach, describe, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor";
import { generateMcpServer } from "../src/mcp-generator";
import mapsJSON from "../src/apps/google-maps.json";
import placesJSON from "../src/apps/google-places.json";
import type { AppTemplate, AppToolTemplate, Connection } from "../src/types";

const maps = mapsJSON as AppTemplate;
const places = placesJSON as AppTemplate;
const credentials = { fields: { api_key: "test-key" } };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function tool(app: AppTemplate, name: string): AppToolTemplate {
  return app.tools.find(t => t.name === name)!;
}

// Expected URLs and parameters follow Google's wire contracts. Fetch is mocked:
// these checks never call Google or require a billing-enabled API key.
describe("Google Maps HTTP contracts", () => {
  const cases = [
    {
      name: "geocode_address", path: "/geocode/json",
      input: { address: "Lyon, France", components: "country:FR|locality:Lyon", bounds: "45.7,4.7|45.9,4.9" },
    },
    {
      name: "reverse_geocode", path: "/geocode/json",
      input: { latlng: "45.764,4.8357", result_type: "street_address|route", location_type: "ROOFTOP|RANGE_INTERPOLATED" },
    },
    {
      name: "get_directions", path: "/directions/json",
      input: { origin: "Lyon, France", destination: "Paris, France", waypoints: "optimize:true|Dijon,France|Beaune,France", avoid: "tolls|highways", alternatives: false },
    },
    {
      name: "calculate_distances", path: "/distancematrix/json",
      input: { origins: "Lyon,France|Paris,France", destinations: "Dijon,France|Marseille,France", avoid: "tolls|ferries" },
    },
    {
      name: "get_elevation", path: "/elevation/json",
      input: { locations: "45.764,4.8357|48.8566,2.3522" },
    },
    {
      name: "get_timezone", path: "/timezone/json",
      input: { location: "45.764,4.8357", timestamp: 1791417600 },
    },
    {
      name: "generate_map", path: "/staticmap",
      input: { center: "Lyon,France", zoom: 12, size: "600x400", markers: "color:red|label:L|45.764,4.8357", path: "color:blue|45.764,4.8357|45.75,4.85" },
    },
    {
      name: "get_street_view", path: "/streetview",
      input: { location: "45.764,4.8357", size: "600x400", heading: 0, return_error_code: true },
    },
  ];

  for (const { name, path, input } of cases) {
    test(`${name} uses Google authentication and query syntax`, async () => {
      const definition = tool(maps, name);
      const image = ["generate_map", "get_street_view"].includes(name);
      const bytes = new Uint8Array([137, 80, 78, 71]);
      globalThis.fetch = (async (request, options) => {
        const url = new URL(String(request));
        expect(url.origin).toBe("https://maps.googleapis.com");
        expect(url.pathname).toBe(`/maps/api${path}`);
        expect(url.searchParams.get("key")).toBe("test-key");
        expect(new Headers(options?.headers).get("X-API-Key")).toBeNull();
        expect(options?.method).toBe("GET");
        expect(options?.body).toBeUndefined();
        for (const [key, value] of Object.entries(input)) {
          expect(url.searchParams.getAll(key)).toEqual([String(value)]);
        }
        return image
          ? new Response(bytes, { headers: { "Content-Type": "image/png" } })
          : Response.json({ status: "OK" });
      }) as typeof fetch;
      const result = await executeTool({ app: maps, tool: definition, credentials, input });
      expect(result.success).toBe(true);
      if (image) {
        expect((result.data as any)._binary).toBe(true);
        expect((result.data as any).base64).toBe(Buffer.from(bytes).toString("base64"));
      }
    });
  }

  for (const name of ["geocode_address", "reverse_geocode", "get_directions", "calculate_distances", "get_elevation", "get_timezone"]) {
    test(`${name} handles failures carried inside HTTP 200`, async () => {
      const messageField = name === "get_timezone" ? "errorMessage" : "error_message";
      globalThis.fetch = (async () => Response.json({ status: "REQUEST_DENIED", [messageField]: "API key rejected" })) as typeof fetch;
      const result = await executeTool({ app: maps, tool: tool(maps, name), credentials, input: {} });
      expect(result.success).toBe(false);
      expect((result.data as any).code).toBe("REQUEST_DENIED");
      expect((result.data as any).message).toBe("API key rejected");
    });
  }

  test("zero search results are a successful empty response", async () => {
    globalThis.fetch = (async () => Response.json({ status: "ZERO_RESULTS", results: [] })) as typeof fetch;
    const result = await executeTool({ app: maps, tool: tool(maps, "geocode_address"), credentials, input: { address: "unknown" } });
    expect(result.success).toBe(true);
    expect((result.data as any).results).toEqual([]);
  });

  test("schemas require Google-required inputs and expose serialized parameters", () => {
    expect(tool(maps, "get_timezone").input_schema.required).toContain("timestamp");
    for (const name of ["generate_map", "get_street_view"]) {
      expect(tool(maps, name).input_schema.required).toContain("size");
      expect((tool(maps, name).input_schema.properties as any).size.type).toBe("string");
    }
    expect((tool(maps, "reverse_geocode").input_schema.properties as any).latitude).toBeUndefined();
    expect((tool(maps, "get_directions").input_schema.properties as any).optimize_waypoints).toBeUndefined();
  });
});

describe("Google Places HTTP contracts", () => {
  const cases = [
    {
      name: "search_text", path: "/places:searchText", method: "POST",
      input: { textQuery: "swimming pool contractors in Chicago IL", includePureServiceAreaBusinesses: true, pageToken: "next-page-token", fields: "places.id,places.displayName,nextPageToken" },
      response: { places: [{ id: "abc" }], nextPageToken: "another-page" },
    },
    {
      name: "search_nearby", path: "/places:searchNearby", method: "POST",
      input: { includedTypes: ["restaurant"], locationRestriction: { circle: { center: { latitude: 45.764, longitude: 4.8357 }, radius: 1000 } }, fields: "places.id,places.displayName" },
      response: { places: [{ id: "abc" }] },
    },
    {
      name: "get_place", path: "/places/ChIJtest", method: "GET",
      input: { placeId: "ChIJtest", languageCode: "fr", sessionToken: "session-123", fields: "id,displayName,websiteUri,nationalPhoneNumber" },
      response: { id: "ChIJtest", websiteUri: "https://example.org" },
    },
    {
      name: "autocomplete", path: "/places:autocomplete", method: "POST",
      input: { input: "restaurants Lyon", sessionToken: "session-123", includeQueryPredictions: true },
      response: { suggestions: [] },
    },
  ];

  for (const { name, path, method, input, response } of cases) {
    test(`${name} separates field selection from the provider payload`, async () => {
      globalThis.fetch = (async (request, options) => {
        const url = new URL(String(request));
        const headers = new Headers(options?.headers);
        expect(url.origin).toBe("https://places.googleapis.com");
        expect(url.pathname).toBe(`/v1${path}`);
        expect(options?.method).toBe(method);
        expect(headers.get("X-Goog-Api-Key")).toBe("test-key");
        expect(headers.get("X-Goog-FieldMask")).toBeNull();
        if ("fields" in input) expect(url.searchParams.get("fields")).toBe(input.fields!);
        if (method === "POST") {
          const { fields, ...body } = input as Record<string, unknown>;
          expect(JSON.parse(String(options?.body))).toEqual(body);
          expect(headers.get("Content-Type")).toBe("application/json");
        } else {
          expect(options?.body).toBeUndefined();
          expect(url.searchParams.has("placeId")).toBe(false);
          expect(url.searchParams.get("languageCode")).toBe("fr");
          expect(url.searchParams.get("sessionToken")).toBe("session-123");
        }
        return Response.json(response);
      }) as typeof fetch;
      const result = await executeTool({ app: places, tool: tool(places, name), credentials, input });
      expect(result.success).toBe(true);
      expect(result.data).toEqual(response);
    });
  }

  test("schemas require field masks and distinguish text restrictions from nearby circles", () => {
    for (const name of ["search_text", "search_nearby", "get_place"]) {
      expect(tool(places, name).input_schema.required).toContain("fields");
    }
    const text = tool(places, "search_text").input_schema.properties as any;
    expect(Object.keys(text.locationRestriction.properties)).toEqual(["rectangle"]);
    const nearby = tool(places, "search_nearby").input_schema.properties as any;
    expect(Object.keys(nearby.locationRestriction.properties)).toEqual(["circle"]);
    expect(nearby.locationRestriction.properties.circle.properties.radius.exclusiveMinimum).toBe(0);
  });

  test("generated MCP descriptors retain Google auth, fields query routing and binary images", () => {
    const connection = { id: "test", credentials } as Connection;
    const generatedPlaces = generateMcpServer(connection, places);
    expect(generatedPlaces.tools.find(t => t.name === "google-places_search_text")?.http_config.query_params).toEqual(["fields"]);
    expect(generatedPlaces.tools[0].http_config.headers["X-Goog-FieldMask"]).toBeUndefined();
    const generatedMaps = generateMcpServer(connection, maps);
    expect(generatedMaps.tools[0].http_config.url).toBe("https://maps.googleapis.com/maps/api/geocode/json?key=test-key");
    expect(generatedMaps.tools.find(t => t.name === "google-maps_generate_map")?.http_config.response_type).toBe("binary");
  });
});
