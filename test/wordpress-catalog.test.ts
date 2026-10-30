import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const credentials = {
  site_url: "https://blog.example.com",
  username: "admin",
  application_password: "abcd efgh ijkl",
};

function wordpress(): AppTemplate {
  const app = getAppTemplate("wordpress");
  if (!app) throw new Error("Missing WordPress integration catalog");
  return app;
}

function wordpressTool(name: string): AppToolTemplate {
  const tool = wordpress().tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing WordPress tool: ${name}`);
  return tool;
}

// The TS executor only substitutes {{credential.X}} in base_url; the server's
// Go runner resolves the catalog's {{site_url}} (covered in server/). Pin the
// host here so these tests exercise routes, query and body shaping.
function wordpressAt(site: string): AppTemplate {
  return { ...wordpress(), base_url: `${site}/wp-json/wp/v2` };
}

async function capture(name: string, input: Record<string, unknown>) {
  let captured: { url: string; init: RequestInit } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init: init || {} };
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await executeTool({ app: wordpressAt(credentials.site_url), tool: wordpressTool(name), credentials, input });
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (!captured) throw new Error(`${name} issued no request`);
  return captured;
}

describe("WordPress REST integration catalog", () => {
  test("maps every tool to a real wp/v2 route", () => {
    const app = wordpress();
    expect(app.base_url).toBe("{{site_url}}/wp-json/wp/v2");
    expect(app.health_check).toEqual({ tool: "get_current_user" });

    const resources: Array<[string, string, string]> = [
      ["posts", "post", "post_id"],
      ["pages", "page", "page_id"],
      ["media", "media", "media_id"],
      ["comments", "comment", "comment_id"],
      ["categories", "category", "category_id"],
      ["tags", "tag", "tag_id"],
      ["users", "user", "user_id"],
    ];
    const routes: Array<[string, string, string]> = [
      ["upload_media", "POST", "/media"],
      ["get_current_user", "GET", "/users/me"],
      ["search", "GET", "/search"],
    ];
    for (const [plural, singular, id] of resources) {
      routes.push(
        [`list_${plural}`, "GET", `/${plural}`],
        [`get_${singular}`, "GET", `/${plural}/{${id}}`],
        [`update_${singular}`, "POST", `/${plural}/{${id}}`],
        [`delete_${singular}`, "DELETE", `/${plural}/{${id}}`],
      );
      if (singular !== "media") routes.push([`create_${singular}`, "POST", `/${plural}`]);
    }

    expect(app.tools.map((tool) => tool.name).sort()).toEqual(routes.map(([name]) => name).sort());
    for (const [name, method, path] of routes) {
      expect(wordpressTool(name)).toMatchObject({ method, path });
    }
  });

  test("takes site and credentials from the connection, not tool input", () => {
    for (const tool of wordpress().tools) {
      const properties = Object.keys(tool.input_schema.properties as Record<string, unknown>);
      expect(properties).not.toContain("site_url");
      expect(properties).not.toContain("application_password");
      if (tool.name !== "create_user") expect(properties).not.toContain("username");
    }
  });

  test("keeps every path parameter explicit and required", () => {
    for (const tool of wordpress().tools) {
      for (const [, parameter] of tool.path.matchAll(/\{([^}]+)\}/g)) {
        expect(tool.input_schema.properties?.[parameter]).toBeDefined();
        expect(tool.input_schema.required).toContain(parameter);
      }
    }
  });

  test("resolves list filters into the query string with Basic auth", async () => {
    const { url, init } = await capture("list_posts", { per_page: 5, status: "draft", categories: "3,7" });
    expect(url).toBe("https://blog.example.com/wp-json/wp/v2/posts?per_page=5&status=draft&categories=3%2C7");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("admin:abcd efgh ijkl").toString("base64")}`,
    });
  });

  test("puts the id in the path and edits in a JSON body", async () => {
    const { url, init } = await capture("update_post", { post_id: 42, title: "Hello", status: "publish" });
    expect(url).toBe("https://blog.example.com/wp-json/wp/v2/posts/42");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Hello", status: "publish" });
  });

  test("sends force on term deletes as a query parameter", async () => {
    const { url, init } = await capture("delete_tag", { tag_id: 9, force: true });
    expect(url).toBe("https://blog.example.com/wp-json/wp/v2/tags/9?force=true");
    expect(init.method).toBe("DELETE");
  });

  test("sends the new user's login as username in the body", async () => {
    const { url, init } = await capture("create_user", { username: "editor1", email: "e@example.com", password: "pw" });
    expect(url).toBe("https://blog.example.com/wp-json/wp/v2/users");
    expect(JSON.parse(String(init.body))).toEqual({ username: "editor1", email: "e@example.com", password: "pw" });
  });

  test("resolves search and the current user under wp/v2", async () => {
    expect((await capture("search", { search: "pricing", subtype: "page" })).url).toBe(
      "https://blog.example.com/wp-json/wp/v2/search?search=pricing&subtype=page",
    );
    expect((await capture("get_current_user", {})).url).toBe("https://blog.example.com/wp-json/wp/v2/users/me");
  });

  test("uploads media as multipart form data", async () => {
    const { url, init } = await capture("upload_media", {
      file: "data:image/png;base64,iVBORw0KGgo=",
      filename: "logo.png",
      title: "Logo",
      post: 42,
    });
    expect(url).toBe("https://blog.example.com/wp-json/wp/v2/media");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("logo.png");
    expect(form.get("title")).toBe("Logo");
    expect(form.get("post")).toBe("42");
  });
});
