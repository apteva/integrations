import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const app = getAppTemplate("kimi-code")!;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Kimi membership stays separate from Platform and declares only implemented capabilities", () => {
  expect(app.base_url).toBe("https://api.kimi.ai/coding/v1");
  expect(app.base_url).not.toBe(getAppTemplate("moonshot-ai")?.base_url);
  expect(app.auth.credential_fields).toHaveLength(1);
  expect(app.auth.credential_fields?.[0]).toMatchObject({ name: "api_key", required: true });
  expect(app.auth.headers).toEqual({ Authorization: "Bearer {{api_key}}", "User-Agent": "Apteva" });
  expect(app.health_check).toEqual({ tool: "list_models" });
  expect(app.runtime).toMatchObject({ role: "llm", provider_key: "kimi-code", env: { KIMI_CODE_API_KEY: "{{credentials.api_key}}" } });
  expect(app.runtime?.capabilities ?? []).not.toContain("subscription_usage");
  const chat = app.tools.find(tool => tool.name === "chat_completion")!;
  expect(chat.input_schema.required).toEqual(["model", "messages"]);
  expect(chat.input_schema.properties?.model).not.toHaveProperty("default");
  expect(chat.input_schema.properties?.stream).toMatchObject({ enum: [false], default: false });
});

test("membership policy selects only compatible IDs present in the account catalog", () => {
  const policy = app.runtime!.model_policy!;
  const allows = (id: string) => policy.allowed_id_patterns.some(pattern => new RegExp(pattern).test(id));
  for (const id of ["k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]) expect(allows(id)).toBe(true);
  for (const id of ["kimi-k3", "accounts/fireworks/models/kimi-k2p6", "kimi-unknown", "embedding", "k3x1-pro"]) expect(allows(id)).toBe(false);
});

test("coding request preserves reasoning and tools with honest identity and membership authentication", async () => {
  const input = {
    model: "kimi-for-coding",
    messages: [
      { role: "user", content: "Check the build" },
      { role: "assistant", content: "", reasoning_content: "Check the compiler output", tool_calls: [{ id: "call-1", type: "function", function: { name: "build", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "Build passed" },
    ],
    reasoning_effort: "high",
    tools: [{ type: "function", function: { name: "build", parameters: { type: "object" } } }],
  };
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://api.kimi.ai/coding/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer membership-test-key");
    expect(headers.get("User-Agent")).toBe("Apteva");
    expect(JSON.parse(String(init?.body))).toMatchObject(input);
    return Response.json({ choices: [{ message: { content: "Build passed" } }] });
  }) as typeof fetch;
  const result = await executeTool({ app, tool: app.tools[0], credentials: { api_key: "membership-test-key" }, input });
  expect(result.success).toBe(true);
  expect(calls).toBe(1);
});

test("membership health uses read-only authenticated discovery", async () => {
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://api.kimi.ai/coding/v1/models");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer membership-test-key");
    return Response.json({ data: [{ id: "kimi-for-coding", context_length: 262144 }] });
  }) as typeof fetch;
  expect((await executeTool({ app, tool: app.tools[1], credentials: { api_key: "membership-test-key" }, input: {} })).success).toBe(true);
});
