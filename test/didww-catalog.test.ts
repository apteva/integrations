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
