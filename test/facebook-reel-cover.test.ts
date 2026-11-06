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

test("Facebook video upload sends the cover as a multipart image file", async () => {
  const app = getAppTemplate("facebook-api");
  const tool = app?.tools.find(({ name }) => name === "post_video_with_thumbnail");
  if (!app || !tool) throw new Error("Missing Facebook video thumbnail tool");

  let form: FormData | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_, init) => {
    form = init?.body as FormData;
    return Response.json({ id: "page-video" });
  };

  try {
    await executeTool({
      app,
      tool,
      credentials: { access_token: "user-token" },
      input: {
        pageId: "page-id",
        file_url: "https://cdn.example.com/video.mp4",
        access_token: "page-token",
        description: "Test video",
        thumb: { base64: "/9j/", mimeType: "image/jpeg" },
        thumb_filename: "cover.jpg",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(form?.get("file_url")).toBe("https://cdn.example.com/video.mp4");
  expect(form?.get("access_token")).toBe("page-token");
  expect(form?.get("description")).toBe("Test video");
  const thumb = form?.get("thumb");
  expect(thumb).toBeInstanceOf(File);
  if (!(thumb instanceof File)) throw new Error("Expected thumbnail file");
  expect(thumb.name).toBe("cover.jpg");
  expect(thumb.type).toBe("image/jpeg");
  expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255]));
});
