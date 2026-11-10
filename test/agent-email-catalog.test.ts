import { expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

test.each([
  ["agentmail", "https://api.agentmail.to/v0/inboxes/inb%2F1/messages/send", "text"],
  ["agmail", "https://api.agmail.ai/v1/inboxes/inb%2F1/messages", "body"],
  ["dead-simple-email", "https://api.deadsimple.email/v1/inboxes/inb%2F1/messages", "text_body"],
  ["clawmail", "https://api.clawmail.me/v1/inboxes/inb%2F1/messages", "text"],
])("sends the documented email request for %s", async (slug, url, bodyField) => {
  const app = getAppTemplate(slug)!;
  const tool = app.tools.find(tool => tool.name === "send_email")!;
  const body = { to: "recipient@example.com", subject: "Test", [bodyField]: "Hello" };
  const original = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    expect(String(target)).toBe(url);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBe("application/json");
    if (slug === "agentmail") expect(headers.get("idempotency-key")).toBe("retry-1");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    return Response.json({ message_id: "msg_1" });
  };
  try {
    const input = { ...body, inbox_id: "inb/1", ...(slug === "agentmail" ? { idempotency_key: "retry-1" } : {}) };
    const result = await executeTool({ app, tool, input, credentials: { fields: { token: "test-token" } } });
    expect(result.data).toEqual({ message_id: "msg_1" });
    expect(result.success).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("sends InboxAPI credentials as private MCP arguments and decodes the response", async () => {
  const app = getAppTemplate("inboxapi")!;
  const tool = app.tools.find(tool => tool.name === "list_messages")!;
  const original = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    expect(String(target)).toBe("https://mcp.inboxapi.ai/mcp");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_emails", arguments: { limit: 2, token: "test-token" } },
    });
    const payload = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"count":1}' }] } };
    return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const result = await executeTool({
      app, tool, input: { limit: 2, token: "supplied-token", domain: "other.example" },
      credentials: { fields: { token: "test-token" } },
    });
    expect(result.data).toEqual({ count: 1 });
    expect(result.success).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});
