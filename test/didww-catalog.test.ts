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
});
