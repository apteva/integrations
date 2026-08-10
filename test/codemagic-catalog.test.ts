import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function codemagic(): AppTemplate {
  const app = getAppTemplate("codemagic");
  if (!app) throw new Error("Missing Codemagic integration catalog");
  return app;
}

function tool(name: string): AppToolTemplate {
  const found = codemagic().tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Codemagic tool: ${name}`);
  return found;
}

describe("Codemagic integration catalog", () => {
  test("covers on-demand Xcode builds and their operational lifecycle", () => {
    const app = codemagic();
    expect(app.tools).toHaveLength(26);
    expect(new Set(app.tools.map((candidate) => candidate.name)).size).toBe(26);
    expect(app.health_check).toEqual({ tool: "get_current_user", input: {} });
    expect(app.auth.headers).toMatchObject({ "x-auth-token": "{{token}}" });

    expect(tool("start_build")).toMatchObject({
      method: "POST",
      base_url: "https://api.codemagic.io",
      path: "/builds",
    });
    expect(tool("start_build").input_schema.properties.instanceType.enum).toEqual(
      expect.arrayContaining(["mac_mini_m2", "mac_mini_m4"]),
    );
    expect(tool("cancel_build")).toMatchObject({
      method: "POST",
      path: "/builds/{build_id}/cancel",
    });
    expect(tool("get_build")).toMatchObject({
      method: "GET",
      path: "/api/v3/builds/{build_id}",
      headers: { Accept: "application/json" },
      response_path: "data",
    });
    expect(tool("list_build_actions")).toMatchObject({
      method: "GET",
      path: "/api/v3/builds/{build_id}/actions",
    });
    expect(tool("get_build_remote_access")).toMatchObject({
      method: "GET",
      path: "/api/v3/builds/{build_id}/remote-access",
    });
    expect(tool("import_group_variables").input_schema.properties).toMatchObject({
      secure: { type: "boolean" },
      variables: { type: "array", minItems: 1 },
    });
  });

  test("extracts a valid build and rejects an HTML 200 response", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({
        data: { _id: "build-123", status: "building" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const valid = await executeTool({
        app: codemagic(), tool: tool("get_build"),
        credentials: { fields: { token: "cm-token" } },
        input: { build_id: "build-123" },
      });
      expect(valid).toMatchObject({
        success: true,
        data: { _id: "build-123", status: "building" },
      });

      globalThis.fetch = async () => new Response("<!doctype html><html>Codemagic</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      const invalid = await executeTool({
        app: codemagic(), tool: tool("get_build"),
        credentials: { fields: { token: "cm-token" } },
        input: { build_id: "build-ghost" },
      });
      expect(invalid).toMatchObject({
        success: false,
        status: 200,
        data: { error: "response contract violation" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps every path parameter explicit and required", () => {
    for (const candidate of codemagic().tools) {
      const parameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1]);
      for (const parameter of parameters) {
        expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        expect(candidate.input_schema.required).toContain(parameter);
      }
    }
  });

  test("starts a typed M4 Xcode build on the documented legacy route", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ buildId: "build-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const result = await executeTool({
        app: codemagic(),
        tool: tool("start_build"),
        credentials: { fields: { token: "cm-token" } },
        input: {
          appId: "app-123",
          workflowId: "ios-release",
          branch: "main",
          instanceType: "mac_mini_m4",
          environment: {
            groups: ["appstore_credentials", "ios_config"],
            softwareVersions: { xcode: "latest" },
          },
        },
      });
      expect(result.data).toEqual({ buildId: "build-123" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe("https://api.codemagic.io/builds");
    expect(captured?.init.headers).toMatchObject({
      "x-auth-token": "cm-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      appId: "app-123",
      workflowId: "ios-release",
      branch: "main",
      instanceType: "mac_mini_m4",
      environment: {
        groups: ["appstore_credentials", "ios_config"],
        softwareVersions: { xcode: "latest" },
      },
    });
  });

  test("does not leak the Codemagic token to a short-lived artifact URL", async () => {
    let captured: { url: string; headers: HeadersInit | undefined } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), headers: init?.headers };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };

    try {
      await executeTool({
        app: codemagic(),
        tool: tool("download_build_artifact"),
        credentials: { fields: { token: "cm-token" } },
        input: {
          download_url: "https://artifact.example.test/signed/ios.ipa?sig=abc",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured?.url).toBe(
      "https://artifact.example.test/signed/ios.ipa?sig=abc",
    );
    expect(captured?.headers).toEqual({});
  });
});
