import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("netelip integration catalog", () => {
  test("keeps callback commands out of the REST tool catalog", () => {
    const app = getAppTemplate("netelip")!;
    expect(app.tools.map((tool) => tool.name)).toEqual(["launch_call"]);
    expect(app.tools[0].path).toBe("");
    expect(app.tools[0].input_schema.properties?.duration?.minimum).toBe(1);
    expect(app.tools[0].input_schema.properties?.duration?.maximum).toBe(60);
    expect(app.tools[0].description).toContain("webhook handler");
  });
});
