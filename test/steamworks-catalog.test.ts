import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const app = getAppTemplate("steamworks")!;
const credentials = { fields: { api_key: "steam-publisher-test-key" } };
const execute = (name: string, input: Record<string, unknown>) => executeTool({
  app,
  tool: app.tools.find((tool) => tool.name === name)!,
  credentials,
  input,
});

describe("Steamworks publisher connector", () => {
  test.each([
    ["list_apps", "GetPartnerAppListForWebAPIKey/v2", { type_filter: "game,demo" }],
    ["list_builds", "GetAppBuilds/v1", { appid: 480, count: 5 }],
    ["list_branches", "GetAppBetas/v1", { appid: 480 }],
    ["get_depot_versions", "GetAppDepotVersions/v1", { appid: 480 }],
  ] as const)("%s sends publisher auth and filters to the partner endpoint", async (name, method, input) => {
    let capturedURL: URL | undefined;
    let capturedInit: RequestInit | undefined;
    const envelope = { response: { fixture: name } };
    globalThis.fetch = async (url, init) => {
      capturedURL = new URL(String(url));
      capturedInit = init;
      return Response.json(envelope);
    };
    const result = await execute(name, input);
    expect(capturedURL?.origin).toBe("https://partner.steam-api.com");
    expect(capturedURL?.pathname).toBe(`/ISteamApps/${method}/`);
    expect(capturedURL?.searchParams.get("key")).toBe(credentials.fields.api_key);
    for (const [key, value] of Object.entries(input)) {
      expect(capturedURL?.searchParams.get(key)).toBe(String(value));
    }
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.body).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(envelope);
  });

  test("promotion posts a URL-encoded form and preserves a pending confirmation response", async () => {
    let capturedURL: URL | undefined;
    let capturedInit: RequestInit | undefined;
    // The documentation specifies HTTP 201 but does not prescribe its body.
    const envelope = { response: { fixture: "confirmation pending" } };
    globalThis.fetch = async (url, init) => {
      capturedURL = new URL(String(url));
      capturedInit = init;
      return Response.json(envelope, { status: 201 });
    };
    const input = {
      appid: 480, buildid: 12345, betakey: "public",
      steamid: "76561198012345678", description: "Build & test + café",
    };
    const result = await execute("set_build_live", input);
    expect(capturedURL?.pathname).toBe("/ISteamApps/SetAppBuildLive/v2/");
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(capturedInit?.body));
    expect(body.get("key")).toBe(credentials.fields.api_key);
    for (const [key, value] of Object.entries(input)) {
      expect(body.get(key)).toBe(String(value));
      expect(capturedURL?.searchParams.has(key)).toBe(false);
    }
    expect(result.status).toBe(201);
    expect(result.data).toEqual(envelope);
    const schema = app.tools.find((tool) => tool.name === "set_build_live")!.input_schema;
    expect(schema.required).toContain("betakey");
    expect(schema.properties?.betakey).not.toHaveProperty("default");
    expect(schema.properties?.steamid).toMatchObject({ type: "string" });
  });

  test("Steam HTTP errors remain failures", async () => {
    globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
    const result = await execute("list_apps", {});
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
  });

});
