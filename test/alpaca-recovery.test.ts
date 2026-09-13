import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const host of ["paper-api.alpaca.markets", "api.alpaca.markets"]) {
  test(`Alpaca client-ID recovery uses the dedicated endpoint on ${host}`, async () => {
    const app = getAppTemplate("alpaca-trading")!;
    let capturedURL = "";
    let capturedMethod = "";
    globalThis.fetch = (async (url, init) => {
      capturedURL = String(url);
      capturedMethod = init?.method || "GET";
      return Response.json({ id: "broker-123", client_order_id: "o-original+1", status: "accepted" });
    }) as typeof fetch;
    const result = await executeTool({
      app, tool: app.tools.find(t => t.name === "get_order_by_client_order_id")!,
      credentials: { fields: { host, api_key: "test-key", api_secret: "test-secret" } },
      input: { client_order_id: "o-original+1" },
    });
    expect(result.success).toBe(true);
    const url = new URL(capturedURL);
    expect(url.origin).toBe(`https://${host}`);
    expect(url.pathname).toBe("/v2/orders:by_client_order_id");
    expect(url.searchParams.get("client_order_id")).toBe("o-original+1");
    expect(capturedMethod).toBe("GET");
  });
}
