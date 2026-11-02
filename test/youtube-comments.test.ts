import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import { getAuthorizationUrl } from "../src/oauth.js";

const FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function call(name: string, input: Record<string, unknown>) {
  const app = getAppTemplate("youtube-api")!;
  const tool = app.tools.find(t => t.name === name)!;
  let request: { url: URL; init: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    request = { url: new URL(String(url)), init: init || {} };
    return Response.json({ items: [] });
  }) as typeof fetch;
  const result = await executeTool({ app, tool, input, credentials: { access_token: "test-token" } });
  expect(result.success).toBe(true);
  expect(new Headers(request!.init.headers).get("Authorization")).toBe("Bearer test-token");
  return request!;
}

describe("YouTube comments", () => {
  test("comment writes need youtube.force-ssl, requested by default", () => {
    const app = getAppTemplate("youtube-api")!;
    expect(app.auth.oauth2!.scopes).toContain(FORCE_SSL);
    const url = getAuthorizationUrl({ app, clientId: "client", redirectUri: "https://example.test/cb", state: "s" });
    expect(new URL(url).searchParams.get("scope")!.split(" ")).toContain(FORCE_SSL);
  });

  test("channel threads are listed newest activity first for the whole channel", async () => {
    const r = await call("list_channel_comment_threads", { part: "snippet,replies", allThreadsRelatedToChannelId: "UCone", order: "time", maxResults: 100, pageToken: "p2" });
    expect(r.init.method).toBe("GET");
    expect(r.url.pathname).toBe("/youtube/v3/commentThreads");
    expect(Object.fromEntries(r.url.searchParams)).toMatchObject({ part: "snippet,replies", allThreadsRelatedToChannelId: "UCone", order: "time", maxResults: "100", pageToken: "p2" });
  });

  test("replies are paged by parent comment", async () => {
    const r = await call("list_comment_replies", { part: "snippet", parentId: "UgThread", pageToken: "n1" });
    expect(r.init.method).toBe("GET");
    expect(r.url.pathname).toBe("/youtube/v3/comments");
    expect(r.url.searchParams.get("parentId")).toBe("UgThread");
    expect(r.url.searchParams.get("pageToken")).toBe("n1");
  });

  test("a reply is a comments.insert under the parent, not a new thread", async () => {
    const r = await call("reply_to_comment", { snippet: { parentId: "UgThread", textOriginal: "Thanks!" } });
    expect(r.init.method).toBe("POST");
    expect(r.url.pathname).toBe("/youtube/v3/comments");
    expect(r.url.searchParams.get("part")).toBe("snippet");
    expect(JSON.parse(String(r.init.body))).toEqual({ snippet: { parentId: "UgThread", textOriginal: "Thanks!" } });
  });

  test("moderation sends its parameters in the query", async () => {
    const r = await call("set_comment_moderation_status", { id: "UgThread", moderationStatus: "rejected" });
    expect(r.init.method).toBe("POST");
    expect(r.url.pathname).toBe("/youtube/v3/comments/setModerationStatus");
    expect(r.url.searchParams.get("id")).toBe("UgThread");
    expect(r.url.searchParams.get("moderationStatus")).toBe("rejected");
  });

  test("delete removes one comment by id", async () => {
    const r = await call("delete_comment", { id: "UgThread.reply" });
    expect(r.init.method).toBe("DELETE");
    expect(r.url.pathname).toBe("/youtube/v3/comments");
    expect(r.url.searchParams.get("id")).toBe("UgThread.reply");
  });
});

describe("TikTok", () => {
  test("no comment tools point at routes TikTok does not serve", () => {
    const app = getAppTemplate("tiktok-api")!;
    expect(app.tools.filter(t => t.name.includes("comment"))).toEqual([]);
  });
});
