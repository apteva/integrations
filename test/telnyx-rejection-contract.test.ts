import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("Telnyx rejection requires the documented cause and preserves its wire payload", async () => {
  const app = getAppTemplate("telnyx")!;
  const tool = app.tools.find(t => t.name === "reject_call")!;
  expect(tool.input_schema.required).toContain("cause");
  expect(tool.input_schema.properties.cause.enum).toEqual(["CALL_REJECTED", "NOT_FOUND", "TEMPORARILY_UNAVAILABLE", "USER_BUSY"]);
  let url = "", payload: unknown;
  globalThis.fetch = (async (target, options) => {
    url = String(target); payload = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  await executeTool({ app, tool, credentials: { fields: { api_key: "test-only" } }, input: { call_control_id: "call-123", cause: "CALL_REJECTED", command_id: "reject-once" } });
  expect(url).toBe("https://api.telnyx.com/v2/calls/call-123/actions/reject");
  expect(payload).toEqual({ cause: "CALL_REJECTED", command_id: "reject-once" });
});
