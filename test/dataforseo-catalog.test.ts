import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DataForSEO integration catalog", () => {
  test("wraps bulk keyword difficulty requests in the required task array", () => {
    const app = getAppTemplate("dataforseo");
    if (!app) throw new Error("Missing DataForSEO integration catalog");

    const tool = app.tools.find((candidate) => candidate.name === "keyword_difficulty");
    expect(tool).toBeDefined();
    expect(tool?.body_root_param).toBe("tasks");
    expect(tool?.path).toBe("/dataforseo_labs/google/bulk_keyword_difficulty/live");
  });

  test("exposes Standard Queue submission and advanced collection", () => {
    const app = getAppTemplate("dataforseo");
    if (!app) throw new Error("Missing DataForSEO integration catalog");

    const submit = app.tools.find((candidate) => candidate.name === "serp_organic_task_post");
    const collect = app.tools.find((candidate) => candidate.name === "serp_organic_task_get");
    expect(submit?.method).toBe("POST");
    expect(submit?.path).toBe("/serp/google/organic/task_post");
    expect(submit?.body_root_param).toBe("tasks");
    expect(collect?.method).toBe("GET");
    expect(collect?.path).toBe("/serp/google/organic/task_get/advanced/{id}");
    expect(collect?.input_schema.required).toContain("id");
  });

  test("sends queue tasks as a root array and substitutes collection IDs", async () => {
    const app = getAppTemplate("dataforseo");
    if (!app) throw new Error("Missing DataForSEO integration catalog");
    const submit = app.tools.find((candidate) => candidate.name === "serp_organic_task_post");
    const collect = app.tools.find((candidate) => candidate.name === "serp_organic_task_get");
    if (!submit || !collect) throw new Error("Missing DataForSEO queue tools");

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ status_code: 20000, tasks: [] });
    }) as typeof fetch;
    const credentials = { fields: { login: "user@example.com", password: "secret" } };

    await executeTool({
      app,
      tool: submit,
      credentials,
      input: { tasks: [{ keyword: "seo api", location_code: 2840, language_code: "en", depth: 20 }] },
    });
    await executeTool({ app, tool: collect, credentials, input: { id: "task/123" } });

    expect(calls[0].url).toBe("https://api.dataforseo.com/v3/serp/google/organic/task_post");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual([
      { keyword: "seo api", location_code: 2840, language_code: "en", depth: 20 },
    ]);
    expect(calls[1].url).toBe("https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/task%2F123");
  });
});
