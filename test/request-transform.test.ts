import { describe, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const app: AppTemplate = {
  slug: "test-mail",
  name: "Test Mail",
  description: "Test",
  logo: null,
  categories: [],
  base_url: "https://example.test",
  auth: {
    types: ["bearer"],
    headers: {
      Authorization: "Bearer {{token}}",
    },
  },
  tools: [],
};

const sendTool: AppToolTemplate = {
  name: "send_email",
  description: "Send",
  method: "POST",
  path: "/send",
  input_schema: { type: "object", properties: {} },
  request_transform: {
    type: "mime_email",
    output: "json",
    target: "raw",
    encoding: "base64url",
    include_fields: {
      threadId: "threadId",
    },
  },
};

const draftTool: AppToolTemplate = {
  name: "create_draft",
  description: "Draft",
  method: "POST",
  path: "/drafts",
  input_schema: { type: "object", properties: {} },
  request_transform: {
    type: "mime_email",
    output: "json",
    target: "message.raw",
    encoding: "base64url",
    include_fields: {
      threadId: "message.threadId",
    },
  },
};

describe("request_transform", () => {
  test("mime_email builds a Gmail-style raw MIME body", async () => {
    let captured: { url: string; init: RequestInit; body: any } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = {
        url: String(url),
        init: init || {},
        body: JSON.parse(String(init?.body || "{}")),
      };
      return new Response(JSON.stringify({ id: "sent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app,
        tool: sendTool,
        credentials: { access_token: "tok" },
        input: {
          to: "a@example.com, b@example.com",
          subject: "Olá",
          body: "Plain text",
          htmlBody: "<p>Olá</p>",
          inReplyTo: "<original@example.com>",
          references: "<root@example.com> <original@example.com>",
          threadId: "thread-1",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe("https://example.test/send");
    expect(captured?.init.headers).toEqual({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    });
    expect(captured?.body.threadId).toBe("thread-1");
    const raw = decodeBase64Url(captured?.body.raw);
    expect(raw).toContain("To: a@example.com, b@example.com");
    expect(raw).toContain("Subject: =?UTF-8?B?T2zDoQ==?=");
    expect(raw).toContain("In-Reply-To: <original@example.com>");
    expect(raw).toContain("References: <root@example.com> <original@example.com>");
    expect(raw).toContain("Content-Type: multipart/alternative;");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).toContain("Content-Type: text/html; charset=UTF-8");
  });

  test("mime_email can target nested draft message fields", async () => {
    let body: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ id: "draft" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app,
        tool: draftTool,
        credentials: { access_token: "tok" },
        input: {
          to: "a@example.com",
          subject: "Draft",
          htmlBody: "<p>HTML only</p>",
          threadId: "thread-2",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(body.message.threadId).toBe("thread-2");
    const raw = decodeBase64Url(body.message.raw);
    expect(raw).toContain("Subject: Draft");
    expect(raw).toContain("Content-Type: text/html; charset=UTF-8");
    expect(raw).toContain(Buffer.from("<p>HTML only</p>", "utf8").toString("base64"));
  });
});

describe("response_transform", () => {
  test("email_message decodes Gmail full payloads", async () => {
    const messageTool: AppToolTemplate = {
      name: "get_message",
      description: "Get",
      method: "GET",
      path: "/messages/{messageId}",
      input_schema: { type: "object", properties: {} },
      response_transform: { type: "email_message" },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(gmailMessageFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    let result;
    try {
      result = await executeTool({
        app,
        tool: messageTool,
        credentials: { access_token: "tok" },
        input: { messageId: "msg-1" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.success).toBe(true);
    expect((result.data as any).from).toBe("Alice <alice@example.com>");
    expect((result.data as any).subject).toBe("Hello");
    expect((result.data as any).messageId).toBe("<msg-1@example.com>");
    expect((result.data as any).text).toBe("Plain body");
    expect((result.data as any).html).toBe("<p>HTML body</p>");
    expect((result.data as any).attachments).toEqual([
      {
        filename: "brief.pdf",
        mimeType: "application/pdf",
        attachmentId: "att-1",
        size: 12,
        partId: "2",
      },
    ]);
  });

  test("email_thread normalizes every Gmail message in a thread", async () => {
    const threadTool: AppToolTemplate = {
      name: "get_thread",
      description: "Thread",
      method: "GET",
      path: "/threads/{threadId}",
      input_schema: { type: "object", properties: {} },
      response_transform: { type: "email_thread" },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "thread-1", historyId: "h1", messages: [gmailMessageFixture()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    let result;
    try {
      result = await executeTool({
        app,
        tool: threadTool,
        credentials: { access_token: "tok" },
        input: { threadId: "thread-1" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect((result.data as any).id).toBe("thread-1");
    expect((result.data as any).messages[0].text).toBe("Plain body");
  });
});

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function gmailMessageFixture() {
  return {
    id: "msg-1",
    threadId: "thread-1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Plain body",
    historyId: "h1",
    internalDate: "1779444000000",
    sizeEstimate: 1234,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "To", value: "agent@example.com" },
        { name: "Subject", value: "Hello" },
        { name: "Date", value: "Wed, 22 May 2026 10:00:00 +0000" },
        { name: "Message-ID", value: "<msg-1@example.com>" },
      ],
      parts: [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          parts: [
            {
              partId: "0.1",
              mimeType: "text/plain",
              body: { size: 10, data: encodeBase64Url("Plain body") },
            },
            {
              partId: "0.2",
              mimeType: "text/html",
              body: { size: 16, data: encodeBase64Url("<p>HTML body</p>") },
            },
          ],
        },
        {
          partId: "2",
          mimeType: "application/pdf",
          filename: "brief.pdf",
          body: { size: 12, attachmentId: "att-1" },
        },
      ],
    },
  };
}
