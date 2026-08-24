import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAppCache();
});

function app(slug: string): AppTemplate {
  const value = getAppTemplate(slug);
  if (!value) throw new Error(`Missing public property-signals integration: ${slug}`);
  return value;
}

function tool(slug: string, name: string): AppToolTemplate {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug}.${name}`);
  return value;
}

describe("public property-signals integration catalogs", () => {
  test("load the expected route-bound tools with explicit path parameters", () => {
    const expectedCounts: Record<string, number> = {
      "ademe-dpe": 3,
      "cerema-dvf": 2,
      sitadel: 6,
      "insee-sirene": 6,
      bodacc: 4,
      "nws-weather": 7,
      "noaa-swdi": 5,
      "meteo-france-vigilance": 3,
      "meteo-france-radar": 9,
      "ign-geoplateforme": 8,
    };

    for (const [slug, count] of Object.entries(expectedCounts)) {
      const catalog = app(slug);
      expect(catalog.tools).toHaveLength(count);
      expect(new Set(catalog.tools.map(({ name }) => name)).size).toBe(count);

      for (const candidate of catalog.tools) {
        expect(candidate.input_schema.properties?.body).toBeUndefined();
        for (const match of candidate.path.matchAll(/\{([^}]+)\}/g)) {
          const parameter = match[1];
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
          expect(candidate.input_schema.required).toContain(parameter);
        }
      }
    }
  });

  test("keeps seven sources usable without API credentials", () => {
    for (const slug of [
      "ademe-dpe",
      "cerema-dvf",
      "sitadel",
      "bodacc",
      "nws-weather",
      "noaa-swdi",
      "ign-geoplateforme",
    ]) {
      expect(app(slug).auth.types).toEqual(["none"]);
    }
    expect(app("nws-weather").auth.credential_fields?.map(({ name }) => name)).toEqual([
      "contact_email",
    ]);
  });

  test("pins the current public datasets and production routes", () => {
    expect(tool("ademe-dpe", "search_dpes").path).toBe("/dpe03existant/lines");
    expect(app("cerema-dvf").base_url).toBe("https://apidf-preprod.cerema.fr");
    expect(tool("sitadel", "list_housing_authorizations").path).toContain(
      "8b35affb-55fc-4c1f-915b-7750f974446a",
    );
    expect(tool("sitadel", "list_demolition_permits").path).toContain(
      "1a9a2f0c-56fe-4e69-84a7-fbbda2121f02",
    );
    expect(tool("bodacc", "search_announcements").path).toBe(
      "/annonces-commerciales/records",
    );
    expect(tool("nws-weather", "list_active_alerts").input_schema.properties).not.toHaveProperty(
      "limit",
    );
    expect(tool("noaa-swdi", "search_hail_signatures").path).toBe(
      "/geojson/nx3hail/{date_range}/{limit}/{start_row}",
    );
    expect(tool("ign-geoplateforme", "get_orthophoto").path).toContain(
      "LAYERS=HR.ORTHOIMAGERY.ORTHOPHOTOS",
    );
  });

  test("declares the current SIRENE API-key header", () => {
    expect(app("insee-sirene").base_url).toBe("https://api.insee.fr/api-sirene/3.11");
    expect(app("insee-sirene").auth.headers).toMatchObject({
      "X-INSEE-Api-Key-Integration": "{{api_key}}",
    });
  });

  test("shares Météo-France's client-credential token exchange", () => {
    for (const slug of ["meteo-france-vigilance", "meteo-france-radar"]) {
      const integration = app(slug);
      expect(integration.auth.token_exchange).toMatchObject({
        url: "https://portail-api.meteofrance.fr/token",
        method: "POST",
        content_type: "application/x-www-form-urlencoded",
        headers: { Authorization: "Basic {{application_id}}" },
        body_params: { grant_type: "client_credentials" },
      });
      expect(integration.auth.credential_fields?.map(({ name }) => name)).toEqual([
        "application_id",
      ]);
    }
  });
});

describe("public property-signals request contracts", () => {
  test("builds BODACC's OpenDataSoft query without authentication", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      captured = { url: String(input), init };
      return Response.json({ total_count: 0, results: [] });
    }) as typeof fetch;

    await executeTool({
      app: app("bodacc"),
      tool: tool("bodacc", "search_announcements"),
      credentials: { fields: {} },
      input: {
        where: "familleavis = 'creation'",
        order_by: "dateparution DESC",
        limit: 25,
      },
    });

    const url = new URL(captured?.url || "");
    expect(url.pathname).toBe(
      "/api/explore/v2.1/catalog/datasets/annonces-commerciales/records",
    );
    expect(url.searchParams.get("where")).toBe("familleavis = 'creation'");
    expect(url.searchParams.get("order_by")).toBe("dateparution DESC");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(new Headers(captured?.init?.headers).has("Authorization")).toBe(false);
  });

  test("sends SIRENE identifiers and API-key authentication correctly", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      captured = { url: String(input), init };
      return Response.json({ uniteLegale: {} });
    }) as typeof fetch;

    await executeTool({
      app: app("insee-sirene"),
      tool: tool("insee-sirene", "get_legal_unit"),
      credentials: { fields: { api_key: "insee-key" } },
      input: { siren: "552100554", date: "2026-01-01" },
    });

    expect(captured?.url).toBe(
      "https://api.insee.fr/api-sirene/3.11/siren/552100554?date=2026-01-01",
    );
    expect(new Headers(captured?.init?.headers).get("X-INSEE-Api-Key-Integration")).toBe(
      "insee-key",
    );
  });

  test("builds NOAA SWDI date-range paths and spatial filters", async () => {
    let requestUrl = "";
    globalThis.fetch = (async (input) => {
      requestUrl = String(input);
      return Response.json({ type: "FeatureCollection", features: [] });
    }) as typeof fetch;

    await executeTool({
      app: app("noaa-swdi"),
      tool: tool("noaa-swdi", "search_hail_signatures"),
      credentials: { fields: {} },
      input: {
        date_range: "202608210000:202608220000",
        limit: 100,
        start_row: 1,
        bbox: "-100,25,-90,35",
      },
    });

    expect(requestUrl).toBe(
      "https://www.ncei.noaa.gov/swdiws/geojson/nx3hail/202608210000%3A202608220000/100/1?bbox=-100%2C25%2C-90%2C35",
    );
  });

  test("exchanges a Météo-France application id before calling vigilance", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/token")) {
        return Response.json({ access_token: "meteo-token", expires_in: 3600 });
      }
      return Response.json({ product: {} });
    }) as typeof fetch;

    await executeTool({
      app: app("meteo-france-vigilance"),
      tool: tool("meteo-france-vigilance", "get_current_warning_map"),
      credentials: { fields: { application_id: "application-id" } },
      input: {},
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://portail-api.meteofrance.fr/token");
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
      "Basic application-id",
    );
    expect(String(calls[0].init?.body)).toBe("grant_type=client_credentials");
    expect(calls[1].url).toBe(
      "https://public-api.meteofrance.fr/public/DPVigilance/v1/cartevigilance/encours",
    );
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe(
      "Bearer meteo-token",
    );
  });

  test("preserves IGN WFS controls while adding the request bounding box", async () => {
    let requestUrl = "";
    globalThis.fetch = (async (input) => {
      requestUrl = String(input);
      return Response.json({ type: "FeatureCollection", features: [] });
    }) as typeof fetch;

    await executeTool({
      app: app("ign-geoplateforme"),
      tool: tool("ign-geoplateforme", "get_buildings"),
      credentials: { fields: {} },
      input: { bbox: "2.34,48.85,2.35,48.86,EPSG:4326", count: 50 },
    });

    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/wfs/ows");
    expect(url.searchParams.get("typeNames")).toBe("BDTOPO_V3:batiment");
    expect(url.searchParams.get("outputFormat")).toBe("application/json");
    expect(url.searchParams.get("bbox")).toBe("2.34,48.85,2.35,48.86,EPSG:4326");
    expect(url.searchParams.get("count")).toBe("50");
  });
});
