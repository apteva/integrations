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
  test("header_params sends an input as a header without leaking it into the body", async () => {
    let captured: { headers: HeadersInit | undefined; body: BodyInit | null | undefined } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured = { headers: init?.headers, body: init?.body };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app,
        tool: {
          name: "tts",
          description: "Generate speech",
          method: "POST",
          path: "/tts",
          header_params: { model: "model" },
          input_schema: { type: "object", properties: {} },
        },
        credentials: { access_token: "tok" },
        input: { model: "s2-pro", text: "Hello" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.headers).toEqual({
      Authorization: "Bearer tok",
      model: "s2-pro",
    });
    expect(captured?.body).toBe(JSON.stringify({ text: "Hello" }));
  });

  test("multipart repeat_fields emits array values as repeated text parts", async () => {
    let capturedBody: BodyInit | null | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app,
        tool: {
          name: "clone_voice",
          description: "Clone voice",
          method: "POST",
          path: "/model",
          multipart_form: {
            field_names: ["title", "texts", "tags"],
            repeat_fields: ["texts", "tags"],
            file_fields: { voices: "voices" },
          },
          input_schema: { type: "object", properties: {} },
        },
        credentials: { access_token: "tok" },
        input: {
          title: "Narrator",
          texts: ["first transcript", "second transcript"],
          tags: ["english", "narration"],
          voices: ["UklGRg==", "UklGRw=="],
          voices_filename: "sample.wav",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const form = capturedBody as FormData;
    expect(form.get("title")).toBe("Narrator");
    expect(form.getAll("texts")).toEqual(["first transcript", "second transcript"]);
    expect(form.getAll("tags")).toEqual(["english", "narration"]);
    const voices = form.getAll("voices") as File[];
    expect(voices).toHaveLength(2);
    expect(voices.map((voice) => voice.name)).toEqual(["1-sample.wav", "2-sample.wav"]);
  });

  test("json_api builds attributes and to-one/to-many relationships", async () => {
    let body = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      body = String(init?.body || "");
      return new Response(JSON.stringify({ data: { id: "version-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app,
        tool: {
          name: "create_version",
          description: "Create version",
          method: "POST",
          path: "/versions",
          input_schema: { type: "object", properties: {} },
          request_transform: {
            type: "json_api",
            resource_type: "appStoreVersions",
            attributes: ["versionString", "platform"],
            relationships: {
              app: { source: "app_id", resource_type: "apps" },
              builds: { source: "build_ids", resource_type: "builds", many: true },
            },
          },
        },
        credentials: { access_token: "tok" },
        input: {
          app_id: "app-1",
          versionString: "2.0",
          platform: "IOS",
          build_ids: ["build-1", "build-2"],
          ignored: "not-on-wire",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(JSON.parse(body)).toEqual({
      data: {
        type: "appStoreVersions",
        attributes: { versionString: "2.0", platform: "IOS" },
        relationships: {
          app: { data: { type: "apps", id: "app-1" } },
          builds: {
            data: [
              { type: "builds", id: "build-1" },
              { type: "builds", id: "build-2" },
            ],
          },
        },
      },
    });
  });

  test("body_root_param sends text content as a raw body", async () => {
    let captured: { headers: HeadersInit | undefined; body: BodyInit | null | undefined } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured = { headers: init?.headers, body: init?.body };
      return new Response("", { status: 204 });
    };
    try {
      await executeTool({
        app,
        tool: {
          name: "update_content",
          description: "Update",
          method: "PUT",
          path: "/content",
          headers: { "Content-Type": "text/html" },
          body_root_param: "content",
          input_schema: { type: "object", properties: {} },
        },
        credentials: { access_token: "tok" },
        input: { content: "<h1>Hello</h1>" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.headers).toEqual({
      Authorization: "Bearer tok",
      "Content-Type": "text/html",
    });
    expect(captured?.body).toBe("<h1>Hello</h1>");
  });

  test("omits templated auth headers that resolve empty", async () => {
    let captured: { init: RequestInit } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured = { init: init || {} };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await executeTool({
        app: {
          ...app,
          auth: {
            types: ["bearer"],
            headers: {
              Authorization: "Bearer {{token}}",
              "developer-token": "{{developer_token}}",
              "login-customer-id": "{{manager_customer_id}}",
            },
          },
        },
        tool: {
          name: "list",
          description: "List",
          method: "GET",
          path: "/items",
          input_schema: { type: "object", properties: {} },
        },
        credentials: { access_token: "tok", fields: { developer_token: "dev" } },
        input: {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.init.headers).toEqual({
      Authorization: "Bearer tok",
      "developer-token": "dev",
    });
  });

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

  test("email_thread returns compact message index by default", async () => {
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
      new Response(JSON.stringify({
        id: "thread-1",
        historyId: "h1",
        messages: [
          gmailMessageFixture({ id: "msg-1", snippet: "First" }),
          gmailMessageFixture({ id: "msg-2", snippet: "Second" }),
          gmailMessageFixture({ id: "msg-3", snippet: "Third" }),
        ],
      }), {
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
    expect((result.data as any).messageCount).toBe(3);
    expect((result.data as any).messageIds).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect((result.data as any).messages.map((m: any) => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect((result.data as any).messages[0].snippet).toBe("First");
    expect((result.data as any).messages[0].text).toBeUndefined();
    expect((result.data as any).messages[0].html).toBeUndefined();
  });

  test("email_message applies local compact body controls without forwarding them", async () => {
    const messageTool: AppToolTemplate = {
      name: "get_message",
      description: "Get",
      method: "GET",
      path: "/messages/{messageId}",
      input_schema: { type: "object", properties: {} },
      response_transform: {
        type: "email_message",
        body_mode_param: "body_mode",
        max_chars_param: "max_chars",
        default_body_mode: "compact",
        default_max_chars: 20_000,
        max_chars_limit: 100_000,
      },
    };
    let requestedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (request) => {
      requestedUrl = String(request);
      return new Response(JSON.stringify(gmailMessageFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    let result;
    try {
      result = await executeTool({
        app,
        tool: messageTool,
        credentials: { access_token: "tok" },
        input: { messageId: "msg-1", format: "full", body_mode: "compact", max_chars: 5 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("format")).toBe("full");
    expect(url.searchParams.has("body_mode")).toBe(false);
    expect(url.searchParams.has("max_chars")).toBe(false);
    expect((result.data as any).body).toBe("Plain");
    expect((result.data as any).bodyMimeType).toBe("text/plain");
    expect((result.data as any).text).toBeUndefined();
    expect((result.data as any).html).toBeUndefined();
    expect((result.data as any).bodyReturnedChars).toBe(5);
    expect((result.data as any).bodyTruncated).toBe(true);
    expect((result.data as any).bodyAvailableChars).toEqual({ text: 10, html: 16 });
  });

  test("failed Gmail thread responses preserve an explicit non-retryable not_found error", async () => {
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
      new Response(JSON.stringify({
        error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
      }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    let result;
    try {
      result = await executeTool({
        app,
        tool: threadTool,
        credentials: { access_token: "tok" },
        input: { threadId: "stale-thread" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect((result.data as any).error).toBe("not_found");
    expect((result.data as any).retryable).toBe(false);
    expect((result.data as any).message).toBe("Requested entity was not found.");
    expect((result.data as any).instruction).toContain("Do not retry the same resource ID");
    expect((result.data as any).messages).toBeUndefined();
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

function gmailMessageFixture(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}
