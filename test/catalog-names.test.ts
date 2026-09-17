import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Read source files directly so a loader that skips invalid entries cannot hide
// a regression. Display names feed MCP server names when connections are made.
test("all integration names are dot-free and identifiers are provider-compatible", () => {
  const directory = join(import.meta.dir, "../src/apps");
  const files = readdirSync(directory).filter(name => name.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  const violations: string[] = [];
  const identifiers = /^[A-Za-z0-9_-]+$/;
  const slugs = new Set<string>();
  for (const file of files) {
    const app = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (typeof app.name !== "string" || !app.name.trim() || app.name.includes(".")) {
      violations.push(`${file}: invalid display/server name ${JSON.stringify(app.name)}`);
    }
    if (typeof app.slug !== "string" || !identifiers.test(app.slug)) {
      violations.push(`${file}: invalid slug ${JSON.stringify(app.slug)}`);
    }
    if (slugs.has(app.slug)) violations.push(`${file}: duplicate slug ${app.slug}`);
    slugs.add(app.slug);
    const toolNames = new Set<string>();
    for (const tool of app.tools || []) {
      if (typeof tool.name !== "string" || !identifiers.test(tool.name)) {
        violations.push(`${file}: invalid tool name ${JSON.stringify(tool.name)}`);
      }
      if (toolNames.has(tool.name)) violations.push(`${file}: duplicate tool ${tool.name}`);
      toolNames.add(tool.name);
    }
  }
  expect(violations).toEqual([]);
});
