import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SignalWire integration catalog", () => {
  test("covers messaging, number lifecycle, recordings, conferences, and queues", () => {
    const app = getAppTemplate("signalwire")!;
    const names = new Set(app.tools.map((tool) => tool.name));
    for (const name of [
      "send_message",
      "update_phone_number",
      "release_phone_number",
      "list_recordings",
      "delete_recording",
      "update_conference_participant",
      "dequeue_member",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("form-encodes repeated MMS media URLs", async () => {
    const app = getAppTemplate("signalwire")!;
    const tool = app.tools.find((candidate) => candidate.name === "send_message")!;
    let body = "";
    globalThis.fetch = (async (_url, options) => {
      body = String(options?.body || "");
      return new Response(JSON.stringify({ sid: "message-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      credentials: {
        fields: {
          username: "project",
          password: "token",
          account_sid: "project",
          space: "example",
        },
      },
      input: {
        To: "+33102030405",
        From: "+33102030406",
        Body: "photo",
        MediaUrl: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      },
    });

    const form = new URLSearchParams(body);
    expect(form.getAll("MediaUrl")).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
    ]);
  });
});
