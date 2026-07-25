import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Venice video integration catalog", () => {
  test("exposes both flat and structured reference-to-video inputs", () => {
    const app = getAppTemplate("venice-ai");
    if (!app) throw new Error("Missing Venice AI integration catalog");
    const queue = app.tools.find((tool) => tool.name === "queue_video");
    if (!queue) throw new Error("Missing Venice queue_video tool");

    const properties = queue.input_schema.properties || {};
    expect(properties.reference_image_urls).toBeDefined();
    expect(properties.elements).toBeDefined();
    expect(properties.scene_image_urls).toBeDefined();

    const element = properties.elements.items;
    expect(element.properties.frontal_image_url).toBeDefined();
    expect(element.properties.reference_image_urls).toBeDefined();
    expect(element.properties.video_url).toBeDefined();
    expect(element.properties.voice_id).toBeDefined();
  });
});
