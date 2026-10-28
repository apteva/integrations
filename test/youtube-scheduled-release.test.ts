import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("YouTube scheduled release on upload", () => {
  test("upload_video_init exposes an optional publishAt like update_video", () => {
    const app = getAppTemplate("youtube-api")!;
    for (const name of ["upload_video_init", "update_video"]) {
      const status = (app.tools.find(t => t.name === name)!.input_schema as any).properties.status;
      expect(status.properties.publishAt.type).toBe("string");
      expect(status.properties.publishAt.default).toBeUndefined();
      expect(status.required || []).not.toContain("publishAt");
    }
  });

  for (const publishAt of ["2026-10-28T19:00:00Z", undefined]) {
    test(`upload_video_init sends publishAt=${String(publishAt)} unchanged`, async () => {
      const app = getAppTemplate("youtube-api")!;
      const tool = app.tools.find(t => t.name === "upload_video_init")!;
      let body: any;
      globalThis.fetch = (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({});
      }) as typeof fetch;
      const status: Record<string, unknown> = { privacyStatus: "private" };
      if (publishAt) status.publishAt = publishAt;
      const input = { snippet: { title: "Tonight" }, status };
      const result = await executeTool({ app, tool, input, credentials: { access_token: "test-token" } });
      expect(result.success).toBe(true);
      expect(body).toEqual(input);
      expect(Object.hasOwn(body.status, "publishAt")).toBe(publishAt !== undefined);
    });
  }
});
