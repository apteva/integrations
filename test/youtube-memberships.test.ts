import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import { getAuthorizationUrl } from "../src/oauth.js";

const MEMBERSHIPS = "https://www.googleapis.com/auth/youtube.channel-memberships.creator";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("YouTube memberships", () => {
  test("memberships scope is requested by default with the other YouTube scopes", () => {
    const app = getAppTemplate("youtube-api")!;
    expect(app.auth.oauth2!.scopes).toContain(MEMBERSHIPS);
    const url = getAuthorizationUrl({ app, clientId: "client", redirectUri: "https://example.test/cb", state: "s" });
    expect(new URL(url).searchParams.get("scope")!.split(" ")).toContain(MEMBERSHIPS);
  });

  const cases: Array<[string, Record<string, unknown>, string, Record<string, string>]> = [
    ["list_membership_levels", { part: "id,snippet" }, "/youtube/v3/membershipsLevels", { part: "id,snippet" }],
    ["list_members", { part: "snippet", mode: "all_current", maxResults: 1000, pageToken: "next-1" }, "/youtube/v3/members", { part: "snippet", mode: "all_current", maxResults: "1000", pageToken: "next-1" }],
  ];
  for (const [name, input, path, query] of cases) {
    test(`${name} sends a read-only GET with its query`, async () => {
      const app = getAppTemplate("youtube-api")!;
      const tool = app.tools.find(t => t.name === name)!;
      expect(tool.method).toBe("GET");
      let request: { url: string; init: RequestInit } | undefined;
      globalThis.fetch = (async (url, init) => {
        request = { url: String(url), init: init || {} };
        return Response.json({ items: [] });
      }) as typeof fetch;
      const result = await executeTool({ app, tool, input, credentials: { access_token: "test-token" } });
      expect(result.success).toBe(true);
      const url = new URL(request!.url);
      expect(url.pathname).toBe(path);
      for (const [k, v] of Object.entries(query)) expect(url.searchParams.get(k)).toBe(v);
      expect(request!.init.method).toBe("GET");
      expect(new Headers(request!.init.headers).get("Authorization")).toBe("Bearer test-token");
    });
  }
});
