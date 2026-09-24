import { afterEach, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import codex from "../src/apps/openai-codex.json";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const app = {
  slug: "test", name: "Test", description: "", logo: null, categories: [],
  base_url: "https://example.test", auth: { types: ["api_key"] }, tools: [],
} as AppTemplate;
const tool = {
  name: "send", description: "", method: "POST", path: "/send",
  input_schema: { type: "object", properties: {} }, timeout_ms: 30000, max_timeout_ms: 300000,
} as AppToolTemplate;

test("execution timeout override is stripped before provider dispatch", async () => {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const input = { prompt: "hello", _apteva: { timeout_ms: 240000 } };
  const result = await executeTool({ app, tool, credentials: {}, input });
  expect(result.success).toBe(true);
  expect(body).toEqual({ prompt: "hello" });
  expect(input._apteva.timeout_ms).toBe(240000);
});

test("execution timeout override rejects values beyond the tool maximum", async () => {
  await expect(executeTool({ app, tool, credentials: {}, input: { _apteva: { timeout_ms: 300001 } } })).rejects.toThrow("between 1 and 300000");
});

test("Codex response and chat tools have a longer default", () => {
  for (const name of ["responses_create", "chat_completion", "vision_describe"]) {
    const entry = codex.tools.find((candidate) => candidate.name === name);
    expect(entry?.timeout_ms).toBe(240000);
    expect(entry?.max_timeout_ms).toBe(600000);
  }
});
