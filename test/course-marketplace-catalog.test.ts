import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function requireApp(slug: string): AppTemplate {
  const app = getAppTemplate(slug);
  if (!app) throw new Error(`Missing integration catalog: ${slug}`);
  return app;
}

function requireTool(app: AppTemplate, name: string): AppToolTemplate {
  const tool = app.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${app.slug} tool: ${name}`);
  return tool;
}

function expectAgentSafeCatalog(app: AppTemplate) {
  const names = app.tools.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);

  for (const tool of app.tools) {
    expect(tool.body_root_param).toBeUndefined();
    expect(tool.input_schema.properties?.body).toBeUndefined();
  }
}

describe("course marketplace integration catalogs", () => {
  test("Whop exposes explicit commerce and native course workflows", () => {
    const app = requireApp("whop");
    expectAgentSafeCatalog(app);
    expect(app.auth.headers?.["Api-Version-Date"]).toBe("2026-07-08-1");

    expect(requireTool(app, "create_file")).toMatchObject({ method: "POST", path: "/files" });
    expect(requireTool(app, "create_product")).toMatchObject({ method: "POST", path: "/products" });
    expect(requireTool(app, "create_plan")).toMatchObject({ method: "POST", path: "/plans" });
    expect(requireTool(app, "create_experience")).toMatchObject({
      method: "POST",
      path: "/experiences",
    });
    expect(requireTool(app, "attach_experience")).toMatchObject({
      method: "POST",
      path: "/experiences/{id}/attach",
    });
    expect(requireTool(app, "create_course")).toMatchObject({ method: "POST", path: "/courses" });
    expect(requireTool(app, "create_course_chapter")).toMatchObject({
      method: "POST",
      path: "/course_chapters",
    });
    expect(requireTool(app, "create_course_lesson")).toMatchObject({
      method: "POST",
      path: "/course_lessons",
    });

    expect(requireTool(app, "create_product").input_schema.required).toEqual(
      expect.arrayContaining(["company_id", "title"]),
    );
    expect(requireTool(app, "create_plan").input_schema.properties).toHaveProperty("initial_price");
    expect(requireTool(app, "create_checkout_configuration").input_schema.properties).toHaveProperty(
      "plan_id",
    );
  });

  test("Sikho exposes explicit course authoring and AI generation workflows", () => {
    const app = requireApp("sikho");
    expectAgentSafeCatalog(app);
    expect(app.base_url).toBe("https://sikho.ai/api/v1");
    expect(app.health_check?.tool).toBe("get_profile");

    expect(requireTool(app, "get_quota")).toMatchObject({ method: "GET", path: "/me/quota" });
    expect(requireTool(app, "bulk_create_course")).toMatchObject({
      method: "POST",
      path: "/courses/bulk",
    });
    expect(requireTool(app, "upload_lesson_content")).toMatchObject({
      method: "PUT",
      path: "/lessons/{id}/content/{sectionType}",
    });
    expect(requireTool(app, "generate_lesson_content")).toMatchObject({
      method: "POST",
      path: "/lessons/{id}/generate/{contentType}",
    });
    expect(requireTool(app, "generate_full_lesson")).toMatchObject({
      method: "POST",
      path: "/lessons/{id}/generate-full",
    });

    expect(requireTool(app, "bulk_create_course").input_schema.required).toEqual([
      "course",
      "modules",
    ]);
    expect(requireTool(app, "upload_lesson_content").input_schema.required).toEqual(
      expect.arrayContaining(["id", "sectionType", "content"]),
    );
  });
});
