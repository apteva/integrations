import { test, expect } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const gmail = await Bun.file(new URL("../src/apps/gmail.json", import.meta.url)).json() as AppTemplate;

test("Gmail raw send preserves the encoded MIME body", async () => {
  const tool = gmail.tools.find((tool) => tool.name === "send_raw_email") as AppToolTemplate;
  let body: any;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "msg-1", threadId: "thread-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await executeTool({ app: gmail, tool, credentials: { token: "test" }, input: { raw: "SGVsbG8", threadId: "thread-1" } });
    expect(result.success).toBe(true);
    expect(body).toEqual({ raw: "SGVsbG8", threadId: "thread-1" });
  } finally { globalThis.fetch = original; }
});

test("Gmail raw fetch requests raw format without response truncation", async () => {
  const tool = gmail.tools.find((tool) => tool.name === "get_raw_message") as AppToolTemplate;
  let requested = "";
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ id: "msg-1", raw: "SGVsbG8", labelIds: ["INBOX"] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await executeTool({ app: gmail, tool, credentials: { token: "test" }, input: { messageId: "msg-1", format: "raw" } });
    expect(result.success).toBe(true);
    expect(requested).toContain("/users/me/messages/msg-1?format=raw");
    expect((result.data as any).raw).toBe("SGVsbG8");
  } finally { globalThis.fetch = original; }
});
