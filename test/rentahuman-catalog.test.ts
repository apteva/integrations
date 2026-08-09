import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

function app(): AppTemplate {
  const found = getAppTemplate("rentahuman");
  if (!found) throw new Error("Missing RentAHuman integration catalog");
  return found;
}

function tool(name: string): AppToolTemplate {
  const found = app().tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing RentAHuman tool: ${name}`);
  return found;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("RentAHuman integration catalog", () => {
  test("covers the documented API-key REST surface without duplicate routes", () => {
    const integration = app();
    expect(integration.tools).toHaveLength(63);
    expect(new Set(integration.tools.map((candidate) => candidate.name)).size).toBe(63);
    expect(
      new Set(integration.tools.map((candidate) => `${candidate.method} ${candidate.path}`)).size,
    ).toBe(63);

    expect(integration.auth).toMatchObject({
      types: ["api_key"],
      headers: {
        "X-API-Key": "{{api_key}}",
        Accept: "application/json",
      },
    });
    expect(integration.health_check).toEqual({ tool: "list_api_keys", input: {} });

    for (const candidate of integration.tools) {
      const pathParameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const parameter of pathParameters) {
        const schema = candidate.input_schema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        expect(schema.properties?.[parameter]).toBeDefined();
        expect(schema.required).toContain(parameter);
      }
    }
  });

  test("models complete agent hiring, payment, QA, and webhook workflows", () => {
    expect(tool("create_bounty")).toMatchObject({ method: "POST", path: "/bounties" });
    expect(tool("update_application")).toMatchObject({
      method: "PATCH",
      path: "/bounties/{bountyId}/applications/{applicationId}",
    });
    expect(tool("rent_human").path).toBe("/escrow/agent-checkout");
    expect(tool("confirm_delivery").path).toBe("/escrow/{escrowId}/complete");
    expect(tool("release_payment").path).toBe("/escrow/{escrowId}/release");
    expect(tool("book_service").path).toBe("/services/book");
    expect(tool("bulk_send_money").path).toBe("/transfers/bulk-send");
    expect(tool("create_taste_run").header_params).toEqual({
      idempotencyKey: "Idempotency-Key",
    });
    expect(tool("resolve_qa_escalation").path).toBe(
      "/v1/qa/runs/{runId}/escalations/{applicationId}",
    );

    expect(app().webhooks).toMatchObject({
      signature_header: "X-RentAHuman-Signature",
      registration: {
        method: "POST",
        path: "/webhooks/endpoints",
        url_field: "url",
        events_field: "events",
        id_field: "endpoint.id",
        response_secret_field: "secret",
        delete_path: "/webhooks/endpoints/{id}",
        list_path: "/webhooks/endpoints",
        list_field: "endpoints",
      },
    });
    expect(app().webhooks?.events).toHaveLength(20);
    expect(app().webhooks?.events.map((event) => event.name)).toContain(
      "application.submitted",
    );
    expect(app().webhooks?.events.map((event) => event.name)).toContain(
      "run.report_ready",
    );
  });

  test("does not expose deprecated or non-API-key-only operations", () => {
    const routes = app().tools.map((candidate) => `${candidate.method} ${candidate.path}`);
    expect(routes).not.toContain("POST /agents/register");
    expect(routes).not.toContain("POST /agents/pairing-code");
    expect(routes).not.toContain("POST /keys/register-identity");
    expect(routes).not.toContain("POST /mcp");
    expect(routes).not.toContain("POST /bounties/{bountyId}/applications");
  });

  test("sends authenticated public-search filters in the query string", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ success: true, humans: [], hasMore: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await executeTool({
      app: app(),
      tool: tool("search_humans"),
      credentials: { fields: { api_key: "rah_test_key" } },
      input: {
        skill: "photography",
        city: "Madrid",
        maxRate: 75,
        limit: 5,
      },
    });

    expect(result.success).toBe(true);
    const requestUrl = new URL(captured?.url || "https://invalid.test");
    expect(requestUrl.origin + requestUrl.pathname).toBe("https://rentahuman.ai/api/humans");
    expect(requestUrl.searchParams.get("skill")).toBe("photography");
    expect(requestUrl.searchParams.get("city")).toBe("Madrid");
    expect(requestUrl.searchParams.get("maxRate")).toBe("75");
    expect(new Headers(captured?.init?.headers).get("X-API-Key")).toBe("rah_test_key");
  });

  test("sends a typed dry-run bounty preview as JSON", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ success: true, dryRun: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app: app(),
      tool: tool("create_bounty"),
      credentials: { fields: { api_key: "rah_test_key" } },
      input: {
        title: "Photograph a storefront",
        description: "Take three clear exterior photographs during business hours.",
        completionCriteria: "Return three original photographs with timestamps.",
        evidenceTypes: ["photo"],
        price: 50,
        priceType: "fixed",
        dryRun: true,
        idempotencyKey: "storefront-photo-2026-08-09",
      },
    });

    expect(captured?.url).toBe("https://rentahuman.ai/api/bounties");
    expect(new Headers(captured?.init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      title: "Photograph a storefront",
      description: "Take three clear exterior photographs during business hours.",
      completionCriteria: "Return three original photographs with timestamps.",
      evidenceTypes: ["photo"],
      price: 50,
      priceType: "fixed",
      dryRun: true,
      idempotencyKey: "storefront-photo-2026-08-09",
    });
  });

  test("sends taste-run idempotency only in the required header", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ success: true, run: { id: "run-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app: app(),
      tool: tool("create_taste_run"),
      credentials: { fields: { api_key: "rah_test_key" } },
      input: {
        question: "Which design communicates the offer most clearly?",
        artifacts: [
          { label: "A", url: "https://example.com/a.png" },
          { label: "B", url: "https://example.com/b.png" },
        ],
        respondentCount: 5,
        payPerRespondentCents: 100,
        idempotencyKey: "design-comparison-2026-08-09",
      },
    });

    expect(new Headers(captured?.init?.headers).get("Idempotency-Key")).toBe(
      "design-comparison-2026-08-09",
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      question: "Which design communicates the offer most clearly?",
      artifacts: [
        { label: "A", url: "https://example.com/a.png" },
        { label: "B", url: "https://example.com/b.png" },
      ],
      respondentCount: 5,
      payPerRespondentCents: 100,
    });
  });
});
