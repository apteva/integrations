import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Zadarma integration catalog", () => {
  test("covers number routing/lifecycle, compliance documents, PBX stats, and recognition", () => {
    const app = getAppTemplate("zadarma")!;
    const names = new Set(app.tools.map((tool) => tool.name));
    for (const name of [
      "prolong_direct_number",
      "set_direct_number_autoprolongation",
      "route_direct_number",
      "create_document_group",
      "upload_document",
      "validate_document_group",
      "get_pbx_statistics",
      "request_speech_recognition",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("has no duplicate method/path operations", () => {
    const app = getAppTemplate("zadarma")!;
    const routes = app.tools.map((tool) => `${tool.method} ${tool.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
