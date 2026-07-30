import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Vonage integration catalog", () => {
  test("uses only official routes with no duplicate method/path tools", () => {
    const app = getAppTemplate("vonage");
    expect(app).toBeTruthy();
    const routes = app!.tools.map((tool) => `${tool.method} ${tool.base_url || app!.base_url}${tool.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.some((route) => /\/(make-call|get-call|list-calls|hangup-call|transfer-call|send-sms)$/.test(route))).toBe(false);
  });

  test("signs Voice API calls from a pasted RSA private key", async () => {
    const app = getAppTemplate("vonage")!;
    const tool = app.tools.find((candidate) => candidate.name === "list_calls")!;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "");
    let authorization = "";
    globalThis.fetch = (async (_url, options) => {
      authorization = String((options?.headers as Record<string, string>).Authorization || "");
      return new Response(JSON.stringify({ count: 0, _links: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      input: {},
      credentials: { fields: { application_id: "app-123", private_key: pem } },
    });
    expect(authorization).toStartWith("Bearer ");
    expect(JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString()).application_id).toBe("app-123");
  });

  test("does not send Voice JWT authorization to classic number routes", async () => {
    const app = getAppTemplate("vonage")!;
    const tool = app.tools.find((candidate) => candidate.name === "list_owned_numbers")!;
    let requestUrl = "";
    let authorization = "not-called";
    globalThis.fetch = (async (url, options) => {
      requestUrl = String(url);
      authorization = String((options?.headers as Record<string, string>).Authorization || "");
      return new Response(JSON.stringify({ numbers: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      input: { size: 1 },
      credentials: { fields: { api_key: "key", api_secret: "secret" } },
    });
    expect(requestUrl).toContain("api_key=key");
    expect(requestUrl).toContain("api_secret=secret");
    expect(authorization).toBe("");
  });
});
