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
  if (!value) throw new Error(`Missing satellite imagery integration: ${slug}`);
  return value;
}

function tool(slug: string, name: string): AppToolTemplate {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug} tool: ${name}`);
  return value;
}

describe("satellite imagery integration catalogs", () => {
  test("load unique route-bound tools with explicit path parameters", () => {
    const expectedCounts: Record<string, number> = {
      "copernicus-data-space": 7,
      "sentinel-hub": 7,
      planet: 17,
      skyfi: 23,
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
        expect(candidate.input_schema.properties?.body).toBeUndefined();
      }
    }
  });

  test("models shared provider access without duplicate vendor catalogs", () => {
    expect(tool("planet", "search_imagery").input_schema.properties?.item_types).toBeDefined();
    expect(tool("planet", "create_tasking_order").path).toBe("/tasking/v2/orders/");

    const skyfiProviders = tool("skyfi", "search_archives").input_schema.properties
      ?.providers.items.enum;
    expect(skyfiProviders).toContain("PLANET");
    expect(skyfiProviders).toContain("UMBRA");
    expect(skyfiProviders).toContain("VANTOR");
    expect(skyfiProviders).toContain("ICEYE_US");

    expect(tool("copernicus-data-space", "search_sentinel_imagery").path).toBe(
      "/catalog/v1/search",
    );
    expect(tool("sentinel-hub", "search_imagery").path).toBe(
      "/api/v1/catalog/1.0.0/search",
    );
  });

  test("exchanges Copernicus client credentials and calls the free Sentinel catalog", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (String(url).includes("/protocol/openid-connect/token")) {
        return new Response(
          JSON.stringify({ access_token: "cdse-token", expires_in: 600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ collections: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("copernicus-data-space"),
      tool: tool("copernicus-data-space", "list_sentinel_collections"),
      credentials: { fields: { client_id: "client", client_secret: "secret" } },
      input: {},
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("identity.dataspace.copernicus.eu");
    expect(String(calls[0].init.body)).toContain("grant_type=client_credentials");
    expect(String(calls[0].init.body)).toContain("client_id=client");
    expect(calls[1].url).toBe(
      "https://sh.dataspace.copernicus.eu/catalog/v1/collections",
    );
    expect(calls[1].init.headers).toMatchObject({
      Authorization: "Bearer cdse-token",
    });
  });

  test("sends typed SkyFi archive searches with API-key authentication", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ total: 0, archives: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("skyfi"),
      tool: tool("skyfi", "search_archives"),
      credentials: { fields: { api_key: "skyfi-key" } },
      input: {
        aoi: "POLYGON((-3 40,-3 41,-2 41,-2 40,-3 40))",
        productTypes: ["MULTISPECTRAL", "SAR"],
        openData: true,
        pageSize: 20,
      },
    });

    expect(captured?.url).toBe("https://app.skyfi.com/platform-api/archives");
    expect(captured?.init?.headers).toMatchObject({
      "X-Skyfi-Api-Key": "skyfi-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      aoi: "POLYGON((-3 40,-3 41,-2 41,-2 40,-3 40))",
      productTypes: ["MULTISPECTRAL", "SAR"],
      openData: true,
      pageSize: 20,
    });
  });

  test("keeps Planet Data API query controls out of the JSON search body", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const filter = {
      type: "GeometryFilter",
      field_name: "geometry",
      config: { type: "Point", coordinates: [-3.7, 40.4] },
    };
    await executeTool({
      app: app("planet"),
      tool: tool("planet", "search_imagery"),
      credentials: { fields: { api_key: "planet-key" } },
      input: {
        item_types: ["PSScene"],
        filter,
        _page_size: 10,
        _sort: "acquired desc",
      },
    });

    expect(captured?.url).toBe(
      "https://api.planet.com/data/v1/quick-search?_page_size=10&_sort=acquired%20desc",
    );
    expect(captured?.init?.headers).toMatchObject({
      Authorization: "api-key planet-key",
    });
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      item_types: ["PSScene"],
      filter,
    });
  });
});
