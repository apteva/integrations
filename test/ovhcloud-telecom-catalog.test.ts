import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OVHcloud Telecom integration catalog", () => {
  test("keeps telecom separate from compute and covers operational voice workflows", () => {
    const telecom = getAppTemplate("ovhcloud-telecom");
    const compute = getAppTemplate("ovhcloud");
    expect(telecom).toBeTruthy();
    expect(compute).toBeTruthy();
    expect(telecom!.slug).not.toBe(compute!.slug);

    const names = new Set(telecom!.tools.map((tool) => tool.name));
    for (const name of [
      "list_lines",
      "click_to_call",
      "list_line_calls",
      "eavesdrop_line_call",
      "transfer_line_call",
      "get_line_recording",
      "list_agents",
      "create_queue",
      "list_queue_live_calls",
      "whisper_queue_call",
      "get_pabx_recording",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("sends OAuth bearer auth and excludes path parameters from call-control bodies", async () => {
    const app = getAppTemplate("ovhcloud-telecom")!;
    const tool = app.tools.find((candidate) => candidate.name === "transfer_queue_call")!;
    let requestUrl = "";
    let headers: Record<string, string> = {};
    let body = "";
    globalThis.fetch = (async (url, options) => {
      requestUrl = String(url);
      headers = options?.headers as Record<string, string>;
      body = String(options?.body || "");
      return new Response(JSON.stringify({ taskId: 123 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      credentials: { fields: { access_token: "ovh-token" } },
      input: {
        billingAccount: "ovh-billing",
        serviceName: "0033123456789",
        queueId: 7,
        id: 42,
        number: "+33102030405",
      },
    });

    expect(requestUrl).toBe(
      "https://eu.api.ovh.com/1.0/telephony/ovh-billing/easyHunting/0033123456789/hunting/queue/7/liveCalls/42/transfer",
    );
    expect(headers.Authorization).toBe("Bearer ovh-token");
    expect(JSON.parse(body)).toEqual({ number: "+33102030405" });
  });
});
