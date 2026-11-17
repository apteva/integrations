import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DIDWW integration catalog", () => {
  test("covers inventory, ordering, routing, trunks, compliance, capacity, and CDR exports", () => {
    const app = getAppTemplate("didww");
    expect(app).toBeTruthy();
    const names = new Set(app!.tools.map((tool) => tool.name));
    for (const name of [
      "list_available_dids",
      "create_did_reservation",
      "create_order",
      "update_did",
      "set_did_voice_trunk",
      "create_inbound_trunk",
      "create_outbound_trunk",
      "regenerate_outbound_trunk_credentials",
      "create_shared_capacity_group",
      "create_identity",
      "create_address_verification",
      "create_export",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("can clear a DID voice trunk with JSON:API data null", async () => {
    const app = getAppTemplate("didww")!;
    const tool = app.tools.find((candidate) => candidate.name === "set_did_voice_trunk")!;
    let body = "";
    globalThis.fetch = (async (_url, options) => {
      body = String(options?.body || "");
      return new Response(JSON.stringify({ data: { id: "did-1", type: "dids" } }), {
        status: 200,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }) as typeof fetch;
    const document = {
      data: {
        type: "dids",
        id: "did-1",
        relationships: {
          voice_in_trunk: { data: null },
          voice_in_trunk_group: { data: null },
        },
      },
    };
    await executeTool({
      app,
      tool,
      credentials: { fields: { api_key: "didww-token" } },
      input: { id: "did-1", body: document },
    });
    expect(JSON.parse(body)).toEqual(document);
  });

  test("builds DIDWW JSON:API relationships and headers", async () => {
    const app = getAppTemplate("didww")!;
    const tool = app.tools.find((candidate) => candidate.name === "create_did_reservation")!;
    let headers: Record<string, string> = {};
    let body = "";
    globalThis.fetch = (async (_url, options) => {
      headers = options?.headers as Record<string, string>;
      body = String(options?.body || "");
      return new Response(JSON.stringify({ data: { id: "reservation-1", type: "did_reservations" } }), {
        status: 201,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      credentials: { fields: { api_key: "didww-token" } },
      input: { available_did_id: "did-1", description: "customer order" },
    });

    expect(headers["Api-Key"]).toBe("didww-token");
    expect(headers["Content-Type"]).toBe("application/vnd.api+json");
    expect(JSON.parse(body)).toEqual({
      data: {
        type: "did_reservations",
        attributes: { description: "customer order" },
        relationships: {
          available_did: { data: { type: "available_dids", id: "did-1" } },
        },
      },
    });
  });

  test("builds registration identity, address, and verification relationships", async () => {
    const app = getAppTemplate("didww")!;
    const identity = app.tools.find((candidate) => candidate.name === "create_identity")!;
    const address = app.tools.find((candidate) => candidate.name === "create_address")!;
    const verification = app.tools.find((candidate) => candidate.name === "create_address_verification")!;
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body || "{}")));
      return new Response(JSON.stringify({ data: { id: "resource-1", type: "resource" } }), {
        status: 201,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }) as typeof fetch;
    const credentials = { fields: { api_key: "didww-token" } };
    await executeTool({ app, tool: identity, credentials, input: { identity_type: "Business", country_id: "country-fr", company_name: "Flexylead", contact_email: "ops@example.test" } });
    await executeTool({ app, tool: address, credentials, input: { city_name: "Paris", postal_code: "75001", address: "1 Rue de Paris", country_id: "country-fr", identity_id: "identity-1" } });
    await executeTool({ app, tool: verification, credentials, input: { address_id: "address-1", did_ids: ["did-1"], service_description: "voice" } });
    expect(bodies).toEqual([
      { data: { type: "identities", attributes: { company_name: "Flexylead", contact_email: "ops@example.test", identity_type: "Business" }, relationships: { country: { data: { type: "countries", id: "country-fr" } } } } },
      { data: { type: "addresses", attributes: { address: "1 Rue de Paris", city_name: "Paris", postal_code: "75001" }, relationships: { country: { data: { type: "countries", id: "country-fr" } }, identity: { data: { type: "identities", id: "identity-1" } } } } },
      { data: { type: "address_verifications", attributes: { service_description: "voice" }, relationships: { address: { data: { type: "addresses", id: "address-1" } }, dids: { data: [{ type: "dids", id: "did-1" }] } } } },
    ]);
  });
});

// Confirmed against DIDWW API 2026-04-16; /requirements returns HTTP 400.
test("DIDWW requirement aliases use current address-requirement endpoints", async () => {
 const app = getAppTemplate("didww")!;
 const urls: string[] = [];
 globalThis.fetch = (async (url) => { urls.push(String(url)); return new Response(JSON.stringify({data: []}), {headers: {"Content-Type": "application/vnd.api+json"}}); }) as typeof fetch;
 for (const [name,input] of [["list_requirements",{country_id:"fr",include:"business_permanent_document"}],["get_requirement",{id:"requirement-fr"}]] as const) {
  await executeTool({app, tool:app.tools.find(t=>t.name===name)!, credentials:{fields:{api_key:"test-token"}},input});
 }
 expect(new URL(urls[0]).pathname).toBe("/v3/address_requirements");
 expect(new URL(urls[0]).searchParams.get("filter[country.id]")).toBe("fr");
 expect(new URL(urls[0]).searchParams.get("include")).toBe("business_permanent_document");
 expect(new URL(urls[1]).pathname).toBe("/v3/address_requirements/requirement-fr");
});
