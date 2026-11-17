import { expect, test } from "bun:test";
import spaceship from "../src/apps/spaceship.json";
import { executeTool } from "../src/http-executor";
import type { AppTemplate, AppToolTemplate } from "../src/types";

const registration = spaceship.tools.find(tool => tool.name === "register_domain")!;

test("Spaceship registration declares its required purchase inputs and async handle", () => {
  expect(registration.method).toBe("POST");
  expect(registration.path).toBe("/v1/domains/{domain}");
  expect(registration.input_schema.required).toEqual(["domain", "autoRenew", "years", "privacyProtection", "contacts"]);
  expect(registration.response_header_fields).toEqual({ "Spaceship-Async-OperationId": "operation_id" });
  expect(spaceship.tools.some(tool => tool.name === "get_async_operation")).toBe(true);
});

for (const { operation, body } of [
  { operation: "operation123", body: null },
  { operation: "", body: null },
  { operation: "operation456", body: { accepted: true } },
]) {
  test(`Spaceship preserves only the declared async header (${operation || "absent"})`, async () => {
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: async request => {
      calls++;
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/v1/domains/example.com");
      expect(request.headers.get("X-API-Key")).toBe("test-key");
      expect(request.headers.get("X-API-Secret")).toBe("test-secret");
      expect(await request.json()).toEqual({ autoRenew: false, years: 2, privacyProtection: { level: "high", userConsent: true }, contacts: { registrant: "contact-id" } });
      return new Response(body ? JSON.stringify(body) : null, { status: 202, headers: { "Spaceship-Async-OperationId": operation, "Set-Cookie": "secret=cookie", ...(body ? { "Content-Type": "application/json" } : {}) } });
    } });
    try {
      const result = await executeTool({
        app: { ...spaceship, base_url: `http://127.0.0.1:${server.port}` } as AppTemplate,
        tool: registration as AppToolTemplate,
        credentials: { api_key: "test-key", api_secret: "test-secret" },
        input: { domain: "example.com", autoRenew: false, years: 2, privacyProtection: { level: "high", userConsent: true }, contacts: { registrant: "contact-id" } },
      });
      expect(calls).toBe(1);
      expect(result.success).toBe(true);
      expect(result.status).toBe(202);
      expect(result.data).toEqual({ ...(body || {}), ...(operation ? { operation_id: operation } : {}) });
    } finally {
      server.stop(true);
    }
  });
}
