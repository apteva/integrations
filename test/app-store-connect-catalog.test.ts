import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

describe("App Store Connect credentials", () => {
  test("declares the .p8 key as a multiline secret", () => {
    const app = getAppTemplate("app-store-connect");
    expect(app).toBeDefined();
    expect(
      app?.auth.credential_fields?.find((field) => field.name === "private_key"),
    ).toMatchObject({ type: "multiline_password" });
  });

  test("signs successfully when an old single-line input flattened the PEM", async () => {
    const app = getAppTemplate("app-store-connect");
    if (!app) throw new Error("Missing App Store Connect integration");
    const tool = app.tools.find((candidate) => candidate.name === "list_apps");
    if (!tool) throw new Error("Missing list_apps tool");

    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const flattenedPEM = pem.replace(/\r?\n/g, "");
    let authorization = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      authorization = String(
        (init?.headers as Record<string, string>)?.Authorization || "",
      );
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const result = await executeTool({
        app,
        tool,
        credentials: {
          fields: {
            issuer_id: "69a6de70-3b5f-47e3-e053-5b8c7c11a4d1",
            key_id: "ABC123DEFG",
            private_key: flattenedPEM,
          },
        },
        input: {},
      });
      expect(result.success).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(authorization).toStartWith("Bearer ");
    expect(authorization.split(".")).toHaveLength(3);
  });
});
