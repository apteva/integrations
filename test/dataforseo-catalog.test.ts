import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("DataForSEO integration catalog", () => {
  test("wraps bulk keyword difficulty requests in the required task array", () => {
    const app = getAppTemplate("dataforseo");
    if (!app) throw new Error("Missing DataForSEO integration catalog");

    const tool = app.tools.find((candidate) => candidate.name === "keyword_difficulty");
    expect(tool).toBeDefined();
    expect(tool?.body_root_param).toBe("tasks");
    expect(tool?.path).toBe("/dataforseo_labs/google/bulk_keyword_difficulty/live");
  });
});
