import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function app(slug: string): AppTemplate {
  const found = getAppTemplate(slug);
  if (!found) throw new Error(`Missing integration catalog: ${slug}`);
  return found;
}

function tool(template: AppTemplate, name: string): AppToolTemplate {
  const found = template.tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${template.slug}:${name}`);
  return found;
}

describe("Social analytics integration catalogs", () => {
  test("puts TikTok fields in the URL and filters in the POST body", async () => {
    const tiktok = app("tiktok-api");
    const originalFetch = globalThis.fetch;

    for (const name of ["list_videos", "query_videos"]) {
      let captured: { url: string; init: RequestInit } | undefined;
      globalThis.fetch = async (url, init) => {
        captured = { url: String(url), init: init || {} };
        return new Response(JSON.stringify({ data: { videos: [] }, error: { code: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const input = name === "query_videos"
        ? {
            fields: "id,view_count",
            filters: { video_ids: ["7667276869607116037"] },
          }
        : {
            fields: "id,view_count",
            max_count: 20,
          };

      await executeTool({
        app: tiktok,
        tool: tool(tiktok, name),
        credentials: { access_token: "tiktok-token" },
        input,
      });

      expect(captured?.url).toContain("?fields=id%2Cview_count");
      expect(captured?.init.method).toBe("POST");
      const body = JSON.parse(String(captured?.init.body || "{}"));
      expect(body.fields).toBeUndefined();
      if (name === "query_videos") {
        expect(body.filters).toEqual({ video_ids: ["7667276869607116037"] });
      } else {
        expect(body.max_count).toBe(20);
      }
    }

    globalThis.fetch = originalFetch;
  });

  test("exposes Facebook video-object and video-insights tools", () => {
    const facebook = app("facebook-api");
    expect(tool(facebook, "facebook_get_video")).toMatchObject({
      method: "GET",
      path: "/{videoId}",
    });
    expect(tool(facebook, "facebook_get_video_insights")).toMatchObject({
      method: "GET",
      path: "/{videoId}/video_insights",
    });
    const defaultFields = tool(facebook, "facebook_get_video").input_schema.properties?.fields?.default;
    expect(defaultFields).toContain("post_id");
    expect(defaultFields).toContain("views");
    expect(defaultFields).not.toContain("shares");
  });

  test("uses current Instagram saved and views metric names", () => {
    const facebook = app("facebook-api");
    expect(tool(facebook, "get_media")).toMatchObject({
      method: "GET",
      path: "/{mediaId}",
    });
    const insights = tool(facebook, "get_media_insights");
    const defaultMetrics = String(insights.input_schema.properties?.metric?.default || "");
    expect(defaultMetrics.split(",")).toEqual(
      expect.arrayContaining(["reach", "views", "likes", "comments", "saved", "shares"]),
    );
    expect(defaultMetrics.split(",")).not.toContain("saves");

    const mockedNames = (insights.mock_response?.data || []).map(
      (entry: { name?: string }) => entry.name,
    );
    expect(mockedNames).toContain("saved");
    expect(mockedNames).not.toContain("saves");
  });
});
