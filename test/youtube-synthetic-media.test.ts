import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("YouTube synthetic-media disclosure", () => {
  test("embedded catalog exposes an optional boolean for upload and update", () => {
    const app = getAppTemplate("youtube-api")!;
    const source = readFileSync(new URL("../src/apps/youtube-api.json", import.meta.url));
    expect(readFileSync(new URL("../../server/integrations-catalog/youtube-api.json", import.meta.url)).equals(source)).toBe(true);
    for (const name of ["upload_video_init", "update_video"]) {
      const schema = app.tools.find(t => t.name === name)!.input_schema as any;
      const status = schema.properties.status;
      expect(status.properties.containsSyntheticMedia.type).toBe("boolean");
      expect(status.properties.containsSyntheticMedia.default).toBeUndefined();
      expect(status.required || []).not.toContain("containsSyntheticMedia");
    }
  });

  for (const name of ["upload_video_init", "update_video"]) {
    for (const disclosure of [true, false, undefined]) {
      test(`${name} preserves ${String(disclosure)} in the provider request`, async () => {
        const app = getAppTemplate("youtube-api")!;
        const tool = app.tools.find(t => t.name === name)!;
        let request: { url: string; init: RequestInit } | undefined;
        globalThis.fetch = (async (url, init) => {
          request = { url: String(url), init: init || {} };
          return Response.json({ id: "test-video" });
        }) as typeof fetch;
        const status: Record<string, unknown> = { privacyStatus: "private" };
        if (disclosure !== undefined) status.containsSyntheticMedia = disclosure;
        const input = { ...(name === "update_video" ? { id: "test-video" } : {}), snippet: { title: "Test video" }, status };
        const result = await executeTool({ app, tool, input, credentials: { access_token: "test-token" } });
        expect(result.success).toBe(true);
        expect(request).toBeDefined();
        expect(new Headers(request!.init.headers).get("Authorization")).toBe("Bearer test-token");
        expect(request!.init.method).toBe(name === "update_video" ? "PUT" : "POST");
        expect(new URL(request!.url).searchParams.get("part")).toBe("snippet,status");
        const body = JSON.parse(String(request!.init.body));
        expect(body).toEqual(input);
        expect(Object.hasOwn(body.status, "containsSyntheticMedia")).toBe(disclosure !== undefined);
      });
    }
  }
});
