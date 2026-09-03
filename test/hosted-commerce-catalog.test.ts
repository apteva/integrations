import { readFileSync } from "node:fs";
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
  if (!value) throw new Error(`Missing hosted-commerce integration: ${slug}`);
  return value;
}

function tool(slug: string, name: string): AppToolTemplate {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug} tool: ${name}`);
  return value;
}

describe("hosted commerce integration catalogs", () => {
  test("cover broad, route-unique seller workflows", () => {
    const expectedCounts: Record<string, number> = {
      etsy: 104,
      fourthwall: 53,
      ecwid: 50,
      square: 16,
    };

    for (const [slug, count] of Object.entries(expectedCounts)) {
      const catalog = app(slug);
      expect(catalog.tools).toHaveLength(count);
      expect(new Set(catalog.tools.map(({ name }) => name)).size).toBe(count);
      expect(
        new Set(catalog.tools.map(({ method, path }) => `${method} ${path}`)).size,
      ).toBe(count);

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

  test("keeps every generated source catalog byte-identical to its server mirror", () => {
    for (const slug of ["etsy", "fourthwall", "ecwid", "square"]) {
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url));
      const mirror = readFileSync(
        new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url),
      );
      expect(mirror.equals(source)).toBe(true);
    }
  });

  test("upgrades Etsy authentication and seller coverage", () => {
    expect(app("etsy").auth.headers).toMatchObject({
      Authorization: "Bearer {{token}}",
      "x-api-key": "{{client_id}}:{{client_secret}}",
    });
    expect(app("etsy").auth.oauth2?.scopes).toEqual(
      expect.arrayContaining(["listings_d", "listings_w", "transactions_w", "address_r"]),
    );

    for (const name of [
      "get_authenticated_user",
      "get_shop_by_owner",
      "list_shop_listings_active",
      "list_shop_receipts",
      "list_shop_reviews",
      "upload_listing_file",
      "update_listing_inventory",
      "upload_listing_image",
      "upload_listing_video",
      "update_listing_personalization",
      "update_variation_images",
      "get_shop_payment_account_ledger_entries",
      "create_shop_shipping_profile",
      "create_shop_return_policy",
    ]) {
      expect(tool("etsy", name)).toBeDefined();
    }

    expect(tool("etsy", "upload_listing_image").multipart_form).toMatchObject({
      file_fields: { image: "image" },
    });
  });

  test("sends Etsy's shared-secret header and listing inventory body correctly", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ products: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("etsy"),
      tool: tool("etsy", "update_listing_inventory"),
      credentials: {
        access_token: "etsy-token",
        fields: { client_id: "etsy-key", client_secret: "etsy-shared-secret" },
      },
      input: {
        listing_id: 123,
        max_variations_supported: "3",
        products: [{ sku: "ROOF-KIT", offerings: [{ price: 19.5, quantity: 4, is_enabled: true }] }],
        price_on_property: [],
        quantity_on_property: [],
        sku_on_property: [],
      },
    });

    expect(captured?.url).toBe(
      "https://openapi.etsy.com/v3/application/listings/123/inventory?max_variations_supported=3",
    );
    expect(new Headers(captured?.init.headers).get("Authorization")).toBe("Bearer etsy-token");
    expect(new Headers(captured?.init.headers).get("x-api-key")).toBe(
      "etsy-key:etsy-shared-secret",
    );
    expect(JSON.parse(String(captured?.init.body))).toMatchObject({
      products: [{ sku: "ROOF-KIT" }],
      price_on_property: [],
    });
  });

  test("builds Fourthwall basic auth and JSON DELETE bodies", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("fourthwall"),
      tool: tool("fourthwall", "remove_product_images"),
      credentials: { username: "shop-api", password: "secret" },
      input: { productId: "product-1", imageUrls: ["https://cdn.example/image.png"] },
    });

    expect(captured?.url).toBe(
      "https://api.fourthwall.com/open-api/v1.0/products/product-1/images",
    );
    expect(new Headers(captured?.init.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("shop-api:secret").toString("base64")}`,
    );
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      imageUrls: ["https://cdn.example/image.png"],
    });
  });

  test("uploads Fourthwall digital files through presigned storage without leaking shop auth", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response("", { status: 200 });
    };

    await executeTool({
      app: app("fourthwall"),
      tool: tool("fourthwall", "upload_presigned_file"),
      credentials: { username: "shop-api", password: "secret" },
      input: {
        upload_url: "https://storage.googleapis.com/fourthwall-upload?signature=signed",
        file: {
          _binary: true,
          base64: Buffer.from("digital-file").toString("base64"),
          mimeType: "application/pdf",
        },
        content_type: "application/pdf",
        content_length_range: "0,12",
      },
    });

    expect(captured?.url).toBe(
      "https://storage.googleapis.com/fourthwall-upload?signature=signed",
    );
    const headers = new Headers(captured?.init.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("Content-Type")).toBe("application/pdf");
    expect(headers.get("x-goog-content-length-range")).toBe("0,12");
    expect(Buffer.from(captured?.init.body as ArrayBuffer).toString()).toBe("digital-file");
  });

  test("resolves Ecwid stores and keeps imported digital files in the query", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ id: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("ecwid"),
      tool: tool("ecwid", "upload_product_file"),
      credentials: { access_token: "ecwid-token", fields: { store_id: "1003" } },
      input: {
        productId: 9,
        fileName: "guide.pdf",
        externalUrl: "https://files.example/guide.pdf",
        description: "Installation guide",
      },
    });

    const url = new URL(captured?.url || "https://invalid.test");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://app.ecwid.com/api/v3/1003/products/9/files",
    );
    expect(url.searchParams.get("fileName")).toBe("guide.pdf");
    expect(url.searchParams.get("externalUrl")).toBe("https://files.example/guide.pdf");
    expect(captured?.init.body).toBe("{}");
    expect(new Headers(captured?.init.headers).get("Authorization")).toBe(
      "Bearer ecwid-token",
    );
  });

  test("creates Square-hosted payment links on the official Checkout route", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ payment_link: { url: "https://square.link/u/demo" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("square"),
      tool: tool("square", "create_payment_link"),
      credentials: { access_token: "square-token" },
      input: {
        idempotency_key: "request-1",
        quick_pay: {
          name: "Roof cleaning kit",
          price_money: { amount: 4900, currency: "USD" },
          location_id: "LOCATION",
        },
      },
    });

    expect(captured?.url).toBe(
      "https://connect.squareup.com/v2/online-checkout/payment-links",
    );
    expect(new Headers(captured?.init.headers).get("Square-Version")).toBe("2026-08-19");
    expect(JSON.parse(String(captured?.init.body))).toMatchObject({
      idempotency_key: "request-1",
      quick_pay: { name: "Roof cleaning kit" },
    });
  });
});
