import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import { generateMcpServer } from "../src/mcp-generator.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("programmable voice carrier catalog", () => {
  test("Bandwidth exposes documented call, conference, recording, and NANP inventory routes", () => {
    const app = getAppTemplate("bandwidth")!;
    expect(app).toBeTruthy();
    const tools = new Map(app.tools.map((tool) => [tool.name, tool]));
    expect(tools.get("create_call")?.path).toBe("/calls");
    expect(tools.get("update_conference_member")?.method).toBe("PUT");
    expect(tools.get("update_call_recording")?.path).toBe("/calls/{callId}/recording");
    expect(tools.get("search_nanp_available_numbers")?.base_url).toBe(
      "https://api.bandwidth.com/api/v1/accounts/{{credential.account_id}}",
    );
  });

  test("Bandwidth recording control sends a JSON state to the right account and call", async () => {
    const app = getAppTemplate("bandwidth")!;
    const tool = app.tools.find((item) => item.name === "update_call_recording")!;
    let request: { url: string; method: string; authorization: string; body: string } | undefined;
    globalThis.fetch = (async (url, options) => {
      const headers = options?.headers as Record<string, string>;
      request = {
        url: String(url),
        method: String(options?.method),
        authorization: headers.Authorization,
        body: String(options?.body),
      };
      return new Response(JSON.stringify({ state: "paused" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      credentials: { fields: { username: "user", password: "pass", account_id: "123" } },
      input: { callId: "call-1", state: "paused" },
    });

    expect(request?.url).toBe("https://voice.bandwidth.com/api/v2/accounts/123/calls/call-1/recording");
    expect(request?.method).toBe("PUT");
    expect(request?.authorization).toBe(`Basic ${btoa("user:pass")}`);
    expect(JSON.parse(request!.body)).toEqual({ state: "paused" });
  });

  test("Sinch v2 call creation keeps serviceId in query and SVAML in JSON body", async () => {
    const app = getAppTemplate("sinch")!;
    const tool = app.tools.find((item) => item.name === "create_call")!;
    let request: { url: string; method: string; authorization: string; body: string } | undefined;
    globalThis.fetch = (async (url, options) => {
      const headers = options?.headers as Record<string, string>;
      request = {
        url: String(url),
        method: String(options?.method),
        authorization: headers.Authorization,
        body: String(options?.body),
      };
      return new Response(JSON.stringify({ sessionIds: ["session-1"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      credentials: { fields: { username: "key", password: "secret", project_id: "project-1" } },
      input: { serviceId: "service-1", commands: [{ command: "dial" }] },
    });

    expect(request?.url).toBe("https://voice.api.sinch.com/v2/projects/project-1/calls?serviceId=service-1");
    expect(request?.method).toBe("POST");
    expect(request?.authorization).toBe(`Basic ${btoa("key:secret")}`);
    expect(JSON.parse(request!.body)).toEqual({ commands: [{ command: "dial" }] });
  });

  test("Sinch Numbers uses its separate API host and repeated capability query values", async () => {
    const app = getAppTemplate("sinch")!;
    const tool = app.tools.find((item) => item.name === "search_available_numbers")!;
    let requestURL = "";
    globalThis.fetch = (async (url) => {
      requestURL = String(url);
      return new Response(JSON.stringify({ availableNumbers: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool,
      credentials: { fields: { username: "key", password: "secret", project_id: "project-1" } },
      input: { regionCode: "FR", type: "LOCAL", capabilities: ["VOICE", "SMS"] },
    });

    const url = new URL(requestURL);
    expect(url.origin).toBe("https://numbers.api.sinch.com");
    expect(url.pathname).toBe("/v1/projects/project-1/availableNumbers");
    expect(url.searchParams.getAll("capabilities")).toEqual(["VOICE", "SMS"]);
  });

  test("DIDWW remains a SIP management integration, not a fictitious REST call controller", () => {
    const app = getAppTemplate("didww")!;
    expect(app.tools.some((tool) => tool.name === "create_outbound_trunk")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "pause_recording" || tool.name === "hold_call")).toBe(false);
    expect(app.description).toContain("Live call media and controls run over SIP");
  });

  test("generated carrier tools resolve connection IDs without changing call path parameters", () => {
    for (const [slug, fields, expected] of [
      ["bandwidth", { username: "user", password: "pass", account_id: "123" }, "https://voice.bandwidth.com/api/v2/accounts/123/calls/{callId}"],
      ["sinch", { username: "key", password: "secret", project_id: "project-1" }, "https://voice.api.sinch.com/v2/projects/project-1/calls/{callId}"],
    ] as const) {
      const app = getAppTemplate(slug)!;
      const generated = generateMcpServer({ id: "test", app_slug: slug, credentials: { fields } } as any, app);
      expect(generated.tools.find((tool) => tool.name === `${slug}_get_call`)?.http_config.url).toBe(expected);
      const inventoryName = slug === "bandwidth" ? "search_nanp_available_numbers" : "search_available_numbers";
      expect(generated.tools.find((tool) => tool.name === `${slug}_${inventoryName}`)?.http_config.url).not.toContain("{{credential.");
    }
  });

  test("new carrier catalogs have unique tools and explicit required path parameters", () => {
    for (const slug of ["bandwidth", "sinch"]) {
      const app = getAppTemplate(slug)!;
      expect(new Set(app.tools.map((tool) => tool.name)).size).toBe(app.tools.length);
      for (const tool of app.tools) {
        for (const [, parameter] of tool.path.matchAll(/\{(\w+)\}/g)) {
          expect(tool.input_schema.properties?.[parameter]).toBeDefined();
          expect(tool.input_schema.required).toContain(parameter);
        }
      }
    }
  });
});
