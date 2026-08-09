import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

const expectedToolCounts: Record<string, number> = {
  "microsoft-sharepoint": 23,
  smartsheet: 18,
  wrike: 21,
  front: 23,
  gorgias: 17,
  freshservice: 19,
  "adobe-acrobat-sign": 14,
  pandadoc: 15,
  greenhouse: 19,
  lever: 18,
  personio: 18,
  vimeo: 18,
  squarespace: 20,
  surveymonkey: 17,
  jotform: 17,
};

function app(slug: string): AppTemplate {
  const found = getAppTemplate(slug);
  if (!found) throw new Error(`Missing integration catalog: ${slug}`);
  return found;
}

function tool(slug: string, name: string): AppToolTemplate {
  const found = app(slug).tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${slug} tool: ${name}`);
  return found;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("end-user SaaS integration catalog", () => {
  test("loads every provider with unique route-level tools", () => {
    for (const [slug, count] of Object.entries(expectedToolCounts)) {
      const integration = app(slug);
      expect(integration.tools).toHaveLength(count);
      expect(new Set(integration.tools.map((candidate) => candidate.name)).size).toBe(count);
      expect(
        new Set(integration.tools.map((candidate) => `${candidate.method} ${candidate.path}`)).size,
      ).toBe(count);
    }
  });

  test("declares every URL path parameter as a required tool argument", () => {
    for (const slug of Object.keys(expectedToolCounts)) {
      for (const candidate of app(slug).tools) {
        const pathParameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
          (match) => match[1],
        );
        for (const parameter of pathParameters) {
          const schema = candidate.input_schema as {
            properties?: Record<string, unknown>;
            required?: string[];
          };
          expect(schema.properties?.[parameter]).toBeDefined();
          expect(schema.required).toContain(parameter);
        }
      }
    }
  });

  test("keeps provider-specific authentication and request shapes explicit", () => {
    expect(app("microsoft-sharepoint").auth.oauth2?.scopes).toContain("Sites.ReadWrite.All");
    expect(app("personio").auth.token_exchange).toMatchObject({
      url: "https://api.personio.de/v1/auth",
      content_type: "application/json",
      access_token_path: "data.token",
    });
    expect(app("jotform").auth.headers?.["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(app("pandadoc").auth.headers?.Authorization).toBe("API-Key {{api_key}}");

    expect(tool("adobe-acrobat-sign", "create_transient_document").multipart_form).toBeDefined();
    expect(tool("personio", "upload_employee_document").multipart_form?.file_fields).toEqual({
      file: "file",
    });
    expect(tool("personio", "list_document_categories").path).toBe(
      "/company/document-categories",
    );
    expect(tool("vimeo", "create_upload").input_schema.properties).toHaveProperty("upload");
    expect(tool("squarespace", "update_product")).toMatchObject({
      method: "POST",
      path: "/v2/commerce/products/{product_id}",
    });
    expect(
      (tool("squarespace", "update_product").input_schema.properties as Record<string, unknown>)
        .name,
    ).toMatchObject({ type: "object" });
  });

  test("sends Wrike create fields as query parameters", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ id: "task-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await executeTool({
      app: app("wrike"),
      tool: tool("wrike", "create_task"),
      credentials: { fields: { token: "test-token" } },
      input: {
        folder_id: "folder-1",
        title: "Follow up",
        status: "Active",
        responsibles: '["KUAAAAAA"]',
      },
    });

    expect(result.success).toBe(true);
    const requestUrl = new URL(captured?.url || "https://invalid.test");
    expect(requestUrl.pathname).toBe("/api/v4/folders/folder-1/tasks");
    expect(requestUrl.searchParams.get("title")).toBe("Follow up");
    expect(requestUrl.searchParams.get("status")).toBe("Active");
    expect(requestUrl.searchParams.get("responsibles")).toBe('["KUAAAAAA"]');
    expect(captured?.init?.body).toBe("{}");
  });

  test("recursively form-encodes Jotform submission answers", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ responseCode: 200, content: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await executeTool({
      app: app("jotform"),
      tool: tool("jotform", "create_submission"),
      credentials: { fields: { api_key: "test-key" } },
      input: {
        form_id: "123",
        submission: { "3": "Ada", "4": { first: "Ada", last: "Lovelace" } },
      },
    });

    expect(result.success).toBe(true);
    expect(captured?.url).toBe("https://api.jotform.com/form/123/submissions");
    expect(new Headers(captured?.init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(captured?.init?.body));
    expect(body.get("submission[3]")).toBe("Ada");
    expect(body.get("submission[4][first]")).toBe("Ada");
    expect(body.get("submission[4][last]")).toBe("Lovelace");
  });
});
