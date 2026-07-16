import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppToolTemplate } from "../src/types.js";

function muxTool(name: string): AppToolTemplate {
  const app = getAppTemplate("mux");
  if (!app) throw new Error("Missing Mux integration catalog");
  const tool = app.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Mux tool: ${name}`);
  return tool;
}

describe("Mux integration catalog", () => {
  test("covers the primary Video API resource families with explicit tools", () => {
    const app = getAppTemplate("mux");
    if (!app) throw new Error("Missing Mux integration catalog");

    expect(app.tools).toHaveLength(58);
    expect(new Set(app.tools.map((tool) => tool.name)).size).toBe(app.tools.length);
    expect(app.auth.headers?.["Content-Type"]).toBe("application/json");
    expect(app.health_check).toEqual({ tool: "list_assets", input: { limit: 1 } });

    const expectedRoutes: Array<[string, string, string]> = [
      ["create_asset", "POST", "/video/v1/assets"],
      ["update_asset", "PATCH", "/video/v1/assets/{ASSET_ID}"],
      ["create_asset_track", "POST", "/video/v1/assets/{ASSET_ID}/tracks"],
      ["generate_asset_subtitles", "POST", "/video/v1/assets/{ASSET_ID}/tracks/{TRACK_ID}/generate-subtitles"],
      ["create_direct_upload", "POST", "/video/v1/uploads"],
      ["cancel_direct_upload", "PUT", "/video/v1/uploads/{UPLOAD_ID}/cancel"],
      ["update_live_stream", "PATCH", "/video/v1/live-streams/{LIVE_STREAM_ID}"],
      ["create_simulcast_target", "POST", "/video/v1/live-streams/{LIVE_STREAM_ID}/simulcast-targets"],
      ["create_playback_restriction", "POST", "/video/v1/playback-restrictions"],
      ["create_transcription_vocabulary", "POST", "/video/v1/transcription-vocabularies"],
      ["list_drm_configurations", "GET", "/video/v1/drm-configurations"],
      ["list_delivery_usage", "GET", "/video/v1/delivery-usage"],
      ["create_signing_key", "POST", "/system/v1/signing-keys"],
    ];

    for (const [name, method, path] of expectedRoutes) {
      expect(muxTool(name)).toMatchObject({ method, path });
    }
  });

  test("keeps every route path parameter explicit and required", () => {
    const app = getAppTemplate("mux")!;
    for (const tool of app.tools) {
      const pathParameters = [...tool.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const parameter of pathParameters) {
        expect(tool.input_schema.properties?.[parameter]).toBeDefined();
        expect(tool.input_schema.required).toContain(parameter);
      }
    }
  });

  test("uses provider fields instead of generic raw request bodies", () => {
    const app = getAppTemplate("mux")!;
    for (const tool of app.tools) {
      expect(tool.body_root_param).toBeUndefined();
      expect(tool.input_schema.properties?.body).toBeUndefined();
      expect(tool.description?.length).toBeGreaterThan(0);
    }

    expect(muxTool("create_asset").input_schema.required).toEqual(["inputs"]);
    expect(muxTool("create_asset").input_schema.properties?.playback_policies).toBeDefined();
    expect(muxTool("create_direct_upload").input_schema.required).toEqual(["cors_origin"]);
    expect(muxTool("create_direct_upload").input_schema.properties?.new_asset_settings).toBeDefined();
    expect(muxTool("create_playback_id").input_schema.properties?.drm_configuration_id).toBeDefined();
    expect(muxTool("create_static_rendition").input_schema.properties?.resolution.enum).toContain("480p");
  });

  test("documents usable playback and direct-upload follow-up flows", () => {
    const app = getAppTemplate("mux")!;
    expect(app.description).toContain("https://stream.mux.com/{PLAYBACK_ID}.m3u8");
    expect(app.description).toContain("https://image.mux.com/{PLAYBACK_ID}/thumbnail.jpg");
    expect(muxTool("create_direct_upload").description).toContain("without Mux Basic auth");
    expect(muxTool("create_signing_key").description).toContain("only once");
  });
});
