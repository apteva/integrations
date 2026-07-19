import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function app(slug: string): AppTemplate {
  const value = getAppTemplate(slug);
  if (!value) throw new Error(`Missing integration catalog: ${slug}`);
  return value;
}

function tool(slug: string, name: string): AppToolTemplate {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug} tool: ${name}`);
  return value;
}

describe("cloud browser REST integration catalogs", () => {
  test("load unique route-bound tools with explicit path parameters", () => {
    const expectedCounts: Record<string, number> = {
      browserless: 23,
      hyperbrowser: 28,
      "anchor-browser": 26,
      notte: 30,
    };

    for (const [slug, count] of Object.entries(expectedCounts)) {
      const catalog = app(slug);
      expect(catalog.tools).toHaveLength(count);
      expect(new Set(catalog.tools.map(({ name }) => name)).size).toBe(count);
      expect(
        new Set(catalog.tools.map(({ method, path }) => `${method} ${path}`)).size,
      ).toBe(count);

      for (const candidate of catalog.tools) {
        for (const match of candidate.path.matchAll(/\{([^}]+)\}/g)) {
          const parameter = match[1];
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
          expect(candidate.input_schema.required).toContain(parameter);
        }
        expect(candidate.input_schema.properties?.body).toBeUndefined();
      }
    }
  });

  test("uses current provider hosts and session routes", () => {
    expect(app("browserless").base_url).toBe("{{credential.endpoint}}");
    expect(tool("browserless", "create_session")).toMatchObject({
      method: "POST",
      path: "/session",
    });

    expect(app("hyperbrowser").base_url).toBe("https://api.hyperbrowser.ai");
    expect(tool("hyperbrowser", "create_session")).toMatchObject({
      method: "POST",
      path: "/api/session",
    });
    expect(tool("hyperbrowser", "list_sessions").path).toBe("/api/sessions");

    expect(tool("anchor-browser", "create_session").path).toBe("/sessions");
    expect(tool("notte", "start_session").path).toBe("/sessions/start");
  });

  test("covers session handoff, profiles, recordings, downloads, and extensions", () => {
    const expectedTools: Record<string, string[]> = {
      browserless: [
        "create_session",
        "run_session_bql",
        "create_profile_session",
        "list_profiles",
        "upload_profile",
      ],
      hyperbrowser: [
        "create_session",
        "get_session_downloads_url",
        "get_session_recording_url",
        "get_session_video_recording_url",
        "create_profile",
        "upload_extension",
      ],
      "anchor-browser": [
        "create_session",
        "list_session_downloads",
        "download_recording",
        "create_profile",
        "create_identity",
        "upload_extension",
      ],
      notte: [
        "start_session",
        "get_session_debug",
        "get_session_replay",
        "execute_page_action",
        "create_profile",
        "start_agent",
        "get_usage",
      ],
    };

    for (const [slug, names] of Object.entries(expectedTools)) {
      const namesInCatalog = new Set(app(slug).tools.map(({ name }) => name));
      for (const name of names) expect(namesInCatalog.has(name)).toBe(true);
    }
  });

  test("keeps recording opt-in in agent-facing session schemas", () => {
    expect(
      tool("browserless", "create_session").input_schema.properties?.replay.default,
    ).toBe(false);
    expect(
      tool("hyperbrowser", "create_session").input_schema.properties
        ?.enableWebRecording.default,
    ).toBe(false);
    expect(
      tool("hyperbrowser", "create_session").input_schema.properties
        ?.enableVideoWebRecording.default,
    ).toBe(false);

    const anchorSession = tool("anchor-browser", "create_session").input_schema
      .properties?.session;
    expect(anchorSession.required).toContain("recording");
    expect(anchorSession.properties.recording.properties.active.default).toBe(false);
  });

  test("resolves a self-hosted Browserless endpoint and token query", async () => {
    const catalog = app("browserless");
    const candidate = tool("browserless", "create_session");
    let captured: { url: string; init?: RequestInit } | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ id: "session-1", connect: "wss://cdp" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await executeTool({
      app: catalog,
      tool: candidate,
      credentials: {
        fields: {
          api_key: "secret-token",
          endpoint: "https://browser.example.com",
        },
      },
      input: { ttl: 60_000, replay: false, browser: "chromium" },
    });

    expect(result.success).toBe(true);
    expect(captured?.url).toBe(
      "https://browser.example.com/session?token=secret-token",
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      ttl: 60_000,
      replay: false,
      browser: "chromium",
      token: "secret-token",
    });
  });

  test("keeps Notte query controls out of typed action bodies", async () => {
    const catalog = app("notte");
    const candidate = tool("notte", "execute_page_action");
    let captured: { url: string; init?: RequestInit } | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app: catalog,
      tool: candidate,
      credentials: { fields: { token: "notte-token" } },
      input: {
        session_id: "session-1",
        update_metadata: false,
        type: "goto",
        url: "https://example.com",
      },
    });

    expect(captured?.url).toBe(
      "https://api.notte.cc/sessions/session-1/page/execute?update_metadata=false",
    );
    expect(new Headers(captured?.init?.headers).get("Authorization")).toBe(
      "Bearer notte-token",
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      type: "goto",
      url: "https://example.com",
    });
  });
});
