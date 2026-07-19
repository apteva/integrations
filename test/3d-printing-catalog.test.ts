import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const productionProviders = [
  "craftcloud",
  "imaterialise",
  "sculpteo",
  "shapeways",
  "slant3d",
  "treatstock",
] as const;

function app(slug: string): AppTemplate {
  const result = getAppTemplate(slug);
  if (!result) throw new Error(`Missing 3D-printing integration: ${slug}`);
  return result;
}

function tool(slug: string, name: string): AppToolTemplate {
  const result = app(slug).tools.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing ${slug} tool: ${name}`);
  return result;
}

describe("3D-printing service catalogs", () => {
  test("use unique route-bound tools with explicit agent-facing arguments", () => {
    for (const slug of productionProviders) {
      const catalog = app(slug);
      const names = catalog.tools.map(({ name }) => name);
      const routes = catalog.tools.map(({ method, path }) => `${method} ${path}`);
      expect(new Set(names).size).toBe(names.length);
      expect(new Set(routes).size).toBe(routes.length);

      for (const candidate of catalog.tools) {
        expect(candidate.description.length).toBeGreaterThan(20);
        expect(candidate.input_schema.properties?.body).toBeUndefined();
        expect(candidate.body_root_param).toBeUndefined();

        const pathParameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
          (match) => match[1],
        );
        for (const parameter of pathParameters) {
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
          expect(candidate.input_schema.required).toContain(parameter);
        }
        for (const parameter of candidate.query_params ?? []) {
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        }
      }
    }
  });

  test("covers a real upload-to-order lifecycle for each operational provider", () => {
    expect(tool("craftcloud", "upload_model")).toMatchObject({ method: "POST", path: "/v5/model" });
    expect(tool("craftcloud", "create_price_request").input_schema.required).toEqual([
      "currency",
      "countryCode",
      "models",
    ]);
    expect(tool("craftcloud", "create_order").input_schema.required).toEqual(["cartId", "user"]);
    expect(tool("craftcloud", "create_stripe_payment")).toMatchObject({
      method: "POST",
      path: "/v5/payment/stripe",
    });
    expect(app("craftcloud").tools.some(({ path }) => path === "/v5/order/{orderId}")).toBe(false);

    expect(tool("imaterialise", "upload_model").multipart_form).toBeDefined();
    expect(tool("imaterialise", "get_product_price")).toMatchObject({
      method: "POST",
      path: "/v1/products/{productId}/price",
    });
    expect(tool("imaterialise", "place_order")).toMatchObject({
      method: "POST",
      path: "/v1/quotations/{quotationId}/order",
    });

    expect(tool("sculpteo", "upload_design").multipart_form?.file_fields).toEqual({ file: "file" });
    expect(app("sculpteo").auth.headers?.["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(Object.keys(tool("sculpteo", "create_order").input_schema.properties ?? {})).toContain(
      "item[0]",
    );

    expect(tool("shapeways", "upload_model").multipart_form).toBeUndefined();
    expect(tool("shapeways", "upload_model").input_schema.required).toEqual(
      expect.arrayContaining(["file", "fileName", "hasRightsToModel", "acceptTermsAndConditions"]),
    );
    expect(tool("shapeways", "place_order").input_schema.properties).toHaveProperty("items");
    expect(tool("shapeways", "list_orders").query_params).toEqual(["orderIds"]);

    expect(tool("slant3d", "upload_presigned_file")).toMatchObject({
      method: "PUT",
      path: "{uploadUrl}",
      body_binary_param: "file",
      omit_auth_headers: ["Authorization"],
    });
    expect(tool("slant3d", "estimate_file_price").path).toBe(
      "/api/files/{publicFileServiceId}/estimate",
    );
    expect(tool("slant3d", "get_files_batch").input_schema.required).toEqual(["publicIds"]);
    expect(tool("slant3d", "get_orders_batch").input_schema.required).toEqual(["public_ids"]);
    expect(tool("slant3d", "create_draft_order").input_schema.required).toEqual([
      "platformId",
      "customer",
      "items",
    ]);

    expect(tool("treatstock", "create_printable_pack").multipart_form).toMatchObject({
      file_fields: { files: "files[]" },
      repeat_fields: ["files-urls[]"],
    });
    expect(tool("treatstock", "list_printing_options")).toMatchObject({
      method: "GET",
      path: "/api/v2/printable-pack-costs/",
    });
    expect(tool("treatstock", "place_order").input_schema.required).toEqual(
      expect.arrayContaining(["printablePackId", "providerId", "shippingAddress"]),
    );
  });

  test("declares read-only credential probes where the upstream supports one", () => {
    expect(app("craftcloud").health_check?.tool).toBe("health_check");
    expect(app("imaterialise").health_check?.tool).toBe("list_technologies");
    expect(app("shapeways").health_check?.tool).toBe("list_materials");
    expect(app("slant3d").health_check?.tool).toBe("list_filaments");
    expect(app("treatstock").health_check?.tool).toBe("list_material_group_colors");
  });

  test("keeps JLC3DP explicitly partner-gated instead of inventing order routes", () => {
    const catalog = app("jlcpcb");
    expect(catalog.description.toLowerCase()).toContain("partner");
    expect(catalog.tools).toHaveLength(3);
    expect(catalog.tools.every(({ method }) => method === "GET")).toBe(true);
  });
});
