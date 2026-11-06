import { expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

test("Facebook-connected Instagram sends Reel cover fields to Graph", async () => {
  const app = getAppTemplate("facebook-api");
  const tool = app?.tools.find(({ name }) => name === "create_media_container");
  if (!app || !tool) throw new Error("Missing Instagram media container tool");

  const requestBodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "reel-container" });
  };

  try {
    const coverOptions = [
      { cover_url: "https://cdn.example.com/cover.jpg" },
      { thumb_offset: 1500 },
    ];
    for (const options of coverOptions) {
      await executeTool({
        app,
        tool,
        credentials: { access_token: "test-token" },
        input: {
          instagramAccountId: "account-id",
          video_url: "https://cdn.example.com/reel.mp4",
          media_type: "REELS",
          ...options,
        },
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(tool.input_schema.properties?.cover_url).toMatchObject({ type: "string" });
  expect(tool.input_schema.properties?.thumb_offset).toMatchObject({ type: "integer" });
  expect(requestBodies).toMatchObject([
    { cover_url: "https://cdn.example.com/cover.jpg", media_type: "REELS" },
    { thumb_offset: 1500, media_type: "REELS" },
  ]);
});

test("Facebook uploads a preferred thumbnail to the existing video", async () => {
  const app = getAppTemplate("facebook-api");
  const tool = app?.tools.find(({ name }) => name === "facebook_set_video_thumbnail");
  if (!app || !tool) throw new Error("Missing Facebook video thumbnail tool");

  let form: FormData | undefined;
  let url: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    url = String(request);
    form = init?.body as FormData;
    return Response.json({ success: true });
  };

  try {
    await executeTool({
      app,
      tool,
      credentials: { access_token: "user-token" },
      input: {
        videoId: "page-video",
        is_preferred: true,
        access_token: "page-token",
        source: { base64: "/9j/", mimeType: "image/jpeg" },
        source_filename: "cover.jpg",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(url).toBe("https://graph.facebook.com/v25.0/page-video/thumbnails");
  expect(form?.get("access_token")).toBe("page-token");
  expect(form?.get("is_preferred")).toBe("true");
  const thumb = form?.get("source");
  expect(thumb).toBeInstanceOf(File);
  if (!(thumb instanceof File)) throw new Error("Expected thumbnail file");
  expect(thumb.name).toBe("cover.jpg");
  expect(thumb.type).toBe("image/jpeg");
  expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255]));
});
