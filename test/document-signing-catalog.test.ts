import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;
const expectedCounts: Record<string, number> = {
  docusign: 26,
  pandadoc: 30,
  "dropbox-sign": 22,
  signwell: 23,
  docuseal: 19,
  documenso: 29,
};

function app(slug: string): AppTemplate {
  const integration = getAppTemplate(slug);
  if (!integration) throw new Error(`Missing integration: ${slug}`);
  return integration;
}

function tool(slug: string, name: string): AppToolTemplate {
  const candidate = app(slug).tools.find((item) => item.name === name);
  if (!candidate) throw new Error(`Missing ${slug} tool: ${name}`);
  return candidate;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("document-signing integration catalog", () => {
  test("loads complete route-unique catalogs", () => {
    for (const [slug, count] of Object.entries(expectedCounts)) {
      const integration = app(slug);
      expect(integration.tools).toHaveLength(count);
      expect(new Set(integration.tools.map((item) => item.name)).size).toBe(count);
      expect(
        new Set(integration.tools.map((item) => `${item.method} ${item.path}`)).size,
      ).toBe(count);
      expect(integration.health_check).toBeDefined();
    }
  });

  test("requires every declared URL path argument", () => {
    for (const slug of Object.keys(expectedCounts)) {
      for (const candidate of app(slug).tools) {
        const parameters = [...candidate.path.matchAll(/\{([^{}]+)\}/g)]
          .map((match) => match[1])
          .filter((parameter) => !parameter.startsWith("credential."));
        const schema = candidate.input_schema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        for (const parameter of parameters) {
          expect(schema.properties?.[parameter]).toBeDefined();
          expect(schema.required).toContain(parameter);
        }
      }
    }
  });

  test("uses documented provider authentication and route families", () => {
    expect(app("docusign").base_url).toBe("{{credential.rest_base_url}}/restapi");
    expect(app("docusign").auth.types).toEqual(["oauth2"]);
    expect(app("docusign").auth.oauth2?.authorize_url).toBe(
      "https://account.docusign.com/oauth/auth",
    );
    expect(app("docusign").auth.oauth2?.scopes).toEqual(["signature", "extended"]);
    expect(
      app("docusign").auth.credential_fields?.filter((field) => field.source === "user")
        .map((field) => field.name),
    ).toEqual(["account_id", "rest_base_url"]);
    expect(app("docusign").tools.every((item) => item.path.startsWith("/v2.1/accounts/"))).toBe(
      true,
    );
    expect(app("docusign").tools.some((item) => item.path === "/send-envelope")).toBe(false);

    expect(app("dropbox-sign").auth.headers).toMatchObject({
      Authorization: "Basic {{basic_auth}}",
      "Content-Type": "application/json",
    });
    expect(tool("dropbox-sign", "send_signature_request")).toMatchObject({
      method: "POST",
      path: "/signature_request/send",
    });

    expect(app("signwell").auth.headers?.["X-Api-Key"]).toBe("{{api_key}}");
    expect(tool("signwell", "create_webhook").path).toBe("/hooks");

    expect(app("docuseal").base_url).toBe("{{credential.base_url}}");
    expect(tool("docuseal", "create_submission_from_pdf").path).toBe("/submissions/pdf");

    expect(app("documenso").base_url).toBe("{{credential.base_url}}");
    expect(app("documenso").auth.headers?.Authorization).toBe("{{api_key}}");
    expect(app("documenso").tools.some((item) => item.path.startsWith("/document"))).toBe(false);
    expect(tool("documenso", "create_envelope").multipart_form).toEqual({
      file_fields: { files: "files" },
      field_names: ["payload"],
    });

    const pandaRoutes = app("pandadoc").tools.map((item) => `${item.method} ${item.path}`);
    expect(pandaRoutes.filter((route) => route === "POST /documents")).toHaveLength(1);
    expect(pandaRoutes).toContain("POST /documents?upload");
    expect(pandaRoutes).toContain("POST /documents/{document_id}/session");
  });

  test("interpolates a DocuSign account base and account ID", async () => {
    let captured: { url?: string; headers?: HeadersInit } = {};
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), headers: init?.headers };
      return new Response(JSON.stringify({ accountIdGuid: "acct-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await executeTool({
      app: app("docusign"),
      tool: tool("docusign", "get_account"),
      credentials: {
        access_token: "docusign-token",
        fields: {
          account_id: "acct-1",
          rest_base_url: "https://demo.docusign.net",
        },
      },
      input: {},
    });

    expect(result.success).toBe(true);
    expect(captured.url).toBe(
      "https://demo.docusign.net/restapi/v2.1/accounts/acct-1",
    );
    expect(new Headers(captured.headers).get("Authorization")).toBe(
      "Bearer docusign-token",
    );
  });

  test("sends Dropbox Sign nested request data as JSON with API-key Basic auth", async () => {
    let captured: { body?: BodyInit | null; headers?: HeadersInit } = {};
    globalThis.fetch = async (_url, init) => {
      captured = { body: init?.body, headers: init?.headers };
      return new Response(JSON.stringify({ signature_request: { signature_request_id: "sr-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("dropbox-sign"),
      tool: tool("dropbox-sign", "send_signature_request"),
      credentials: { fields: { api_key: "dropbox-key" } },
      input: {
        title: "Agreement",
        file_urls: ["https://files.example/agreement.pdf"],
        signers: [{ email_address: "ada@example.com", name: "Ada" }],
        metadata: { customer_id: "42" },
      },
    });

    expect(new Headers(captured.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("dropbox-key:").toString("base64")}`,
    );
    expect(new Headers(captured.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(captured.body))).toEqual({
      title: "Agreement",
      file_urls: ["https://files.example/agreement.pdf"],
      signers: [{ email_address: "ada@example.com", name: "Ada" }],
      metadata: { customer_id: "42" },
    });
  });

  test("builds Documenso create-envelope multipart data", async () => {
    let body: BodyInit | null | undefined;
    globalThis.fetch = async (_url, init) => {
      body = init?.body;
      return new Response(JSON.stringify({ id: "env-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: app("documenso"),
      tool: tool("documenso", "create_envelope"),
      credentials: {
        fields: {
          api_key: "documenso-key",
          base_url: "https://app.documenso.com/api/v2",
        },
      },
      input: {
        payload: { title: "NDA", type: "DOCUMENT" },
        files: ["JVBERi0x", "JVBERi0y"],
        files_filename: "nda.pdf",
      },
    });

    const form = body as FormData;
    expect(form.get("payload")).toBe(JSON.stringify({ title: "NDA", type: "DOCUMENT" }));
    expect(form.getAll("files")).toHaveLength(2);
    expect((form.getAll("files") as File[]).map((file) => file.name)).toEqual([
      "1-nda.pdf",
      "2-nda.pdf",
    ]);
  });
});
