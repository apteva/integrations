import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

describe("Apple Push Notifications integration", () => {
  test("declares a secret APNs key and one send tool", () => {
    const app = getAppTemplate("apple-push-notifications");
    expect(app).toBeDefined();
    expect(app?.auth.signers).toEqual([{ name: "apns_jwt" }]);
    expect(
      app?.auth.credential_fields?.find((field) => field.name === "private_key"),
    ).toMatchObject({ type: "multiline_password" });
    expect(app?.tools.map((tool) => tool.name)).toEqual(["send_notification"]);
  });

  test("signs a sandbox request and keeps transport fields out of the payload", async () => {
    const app = getAppTemplate("apple-push-notifications");
    if (!app) throw new Error("Missing Apple Push Notifications integration");
    const tool = app.tools.find((candidate) => candidate.name === "send_notification");
    if (!tool) throw new Error("Missing send_notification tool");

    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let requestURL = "";
    let requestHeaders: Record<string, string> = {};
    let requestBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requestURL = String(url);
      requestHeaders = init?.headers as Record<string, string>;
      requestBody = String(init?.body || "");
      return new Response("", {
        status: 200,
        headers: { "apns-id": "test-apns-id" },
      });
    };

    try {
      const result = await executeTool({
        app,
        tool,
        credentials: {
          fields: {
            team_id: "TEAM123456",
            key_id: "KEY1234567",
            private_key: pem,
            bundle_id: "ai.apteva.mobile",
            environment: "sandbox",
          },
        },
        input: {
          device_token: "abc123",
          push_type: "alert",
          priority: 10,
          collapse_id: "inbox",
          aps: {
            alert: { title: "Approval required", body: "Open Apteva to review." },
            badge: 2,
          },
          data: { type: "approval", item_id: "1842" },
        },
      });
      expect(result.success).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestURL).toBe("https://api.sandbox.push.apple.com/3/device/abc123");
    expect(requestHeaders.Authorization).toStartWith("Bearer ");
    expect(requestHeaders["apns-topic"]).toBe("ai.apteva.mobile");
    expect(requestHeaders["apns-push-type"]).toBe("alert");
    expect(requestHeaders["apns-priority"]).toBe("10");
    expect(requestHeaders["apns-collapse-id"]).toBe("inbox");
    expect(JSON.parse(requestBody)).toEqual({
      aps: {
        alert: { title: "Approval required", body: "Open Apteva to review." },
        badge: 2,
      },
      data: { type: "approval", item_id: "1842" },
    });
  });
});
