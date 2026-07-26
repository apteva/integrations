import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Google Drive integration catalog", () => {
  test("supports bounded blob downloads through an inclusive byte range", () => {
    const app = getAppTemplate("google-drive");
    if (!app) throw new Error("Missing Google Drive integration catalog");
    const tool = app.tools.find((candidate) => candidate.name === "download_file");
    if (!tool) throw new Error("Missing google-drive.download_file");

    expect(tool.path).toBe("/drive/v3/files/{fileId}?alt=media");
    expect(tool.header_transforms).toEqual([{
      type: "byte_range",
      header: "Range",
      start_param: "start_byte",
      end_param: "end_byte",
    }]);
    expect(tool.input_schema.properties).toMatchObject({
      start_byte: { type: "integer", minimum: 0 },
      end_byte: { type: "integer", minimum: 0 },
    });
  });
});
