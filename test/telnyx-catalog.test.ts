import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Telnyx integration catalog", () => {
  test("exposes each HTTP operation once", () => {
    const app = getAppTemplate("telnyx")!;
    const routes = app.tools.map((tool) => `${tool.method} ${tool.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    expect(app.tools.some((tool) => tool.name === "dial_call")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "hangup_call")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "make_call")).toBe(false);
    expect(app.tools.some((tool) => tool.name === "update_call")).toBe(false);
  });
});
