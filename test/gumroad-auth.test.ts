import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { ConnectionCredentials } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAppCache();
});

describe("Gumroad authentication", () => {
  test("uses a top-level token from a local server credential blob", async () => {
    const app = getAppTemplate("gumroad");
    const tool = app?.tools.find(({ name }) => name === "get_user");
    if (!app || !tool) throw new Error("Missing Gumroad get_user tool");

    let authorization = "";
    globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization") || "";
      return Response.json({ success: true, user: { id: "user-1" } });
    };

    // Local Go connections store catalog-defined fields directly in the
    // decrypted credential object, not under the optional `fields` wrapper.
    const credentials = { token: "gumroad-test-token" } as ConnectionCredentials;
    const result = await executeTool({ app, tool, credentials, input: {} });

    expect(result.success).toBe(true);
    expect(authorization).toBe("Bearer gumroad-test-token");
  });

  test("form-encodes product writes expected by Gumroad", async () => {
    const app = getAppTemplate("gumroad");
    const tool = app?.tools.find(({ name }) => name === "create_product");
    if (!app || !tool) throw new Error("Missing Gumroad create_product tool");

    let contentType = "";
    let body = "";
    let url = "";
    globalThis.fetch = async (requestUrl, init) => {
      url = String(requestUrl);
      contentType = new Headers(init?.headers).get("Content-Type") || "";
      body = String(init?.body || "");
      return Response.json({ success: true, product: { id: "product-1" } });
    };

    const result = await executeTool({
      app,
      tool,
      credentials: { token: "gumroad-test-token" },
      input: {
        name: "Integration Test",
        price: 100,
        published: false,
        tags: ["test", "temporary"],
      },
    });

    const form = new URLSearchParams(body);
    expect(result.success).toBe(true);
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect(form.get("name")).toBe("Integration Test");
    expect(form.get("price")).toBe("100");
    expect(form.get("published")).toBe("false");
    expect(form.getAll("tags")).toEqual([]);
    expect(new URL(url).searchParams.getAll("tags[]")).toEqual(["test", "temporary"]);
  });

  test("covers the direct-upload and public-media workflows", async () => {
    const app = getAppTemplate("gumroad");
    if (!app) throw new Error("Missing Gumroad integration");
    const named = (name: string) => app.tools.find((tool) => tool.name === name);

    for (const name of [
      "create_direct_upload",
      "upload_direct_upload",
      "list_media",
      "create_media",
      "delete_media",
    ]) {
      expect(named(name)).toBeDefined();
    }

    const cover = named("add_cover");
    expect(cover?.input_schema.properties.signed_blob_id).toBeDefined();
    expect(cover?.input_schema.anyOf).toEqual([
      { required: ["signed_blob_id"] },
      { required: ["url"] },
    ]);
  });

  test("form-encodes an Active Storage direct-upload reservation", async () => {
    const app = getAppTemplate("gumroad");
    const tool = app?.tools.find(({ name }) => name === "create_direct_upload");
    if (!app || !tool) throw new Error("Missing Gumroad create_direct_upload tool");

    let body = "";
    globalThis.fetch = async (_url, init) => {
      body = String(init?.body || "");
      return Response.json({
        signed_id: "signed-blob-1",
        direct_upload: { url: "https://storage.example/upload", headers: {} },
      });
    };

    const result = await executeTool({
      app,
      tool,
      credentials: { token: "gumroad-test-token" },
      input: {
        purpose: "media",
        blob: {
          filename: "cover.png",
          byte_size: 68,
          checksum: "checksum-base64",
          content_type: "image/png",
        },
      },
    });

    const form = new URLSearchParams(body);
    expect(result.success).toBe(true);
    expect(form.get("purpose")).toBe("media");
    expect(form.get("blob[filename]")).toBe("cover.png");
    expect(form.get("blob[byte_size]")).toBe("68");
    expect(form.get("blob[checksum]")).toBe("checksum-base64");
    expect(form.get("blob[content_type]")).toBe("image/png");
  });

  test("uploads direct-upload bytes without leaking Gumroad authentication", async () => {
    const app = getAppTemplate("gumroad");
    const tool = app?.tools.find(({ name }) => name === "upload_direct_upload");
    if (!app || !tool) throw new Error("Missing Gumroad upload_direct_upload tool");

    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: BodyInit | null | undefined;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = init?.body;
      return new Response(null, { status: 200 });
    };

    const bytes = Buffer.from("test-image-bytes");
    const result = await executeTool({
      app,
      tool,
      credentials: { token: "gumroad-test-token" },
      input: {
        uploadUrl: "https://storage.example/upload?signature=test",
        file: { _binary: true, base64: bytes.toString("base64"), mimeType: "image/png" },
        content_type: "image/png",
        content_md5: "checksum-base64",
      },
    });

    expect(result.success).toBe(true);
    expect(capturedUrl).toBe("https://storage.example/upload?signature=test");
    expect(capturedHeaders.get("Authorization")).toBeNull();
    expect(capturedHeaders.get("Content-Type")).toBe("image/png");
    expect(capturedHeaders.get("Content-MD5")).toBe("checksum-base64");
    expect(Buffer.from(capturedBody as Uint8Array)).toEqual(bytes);
  });

  test("uses Gumroad's typed resource-subscription contract", () => {
    const app = getAppTemplate("gumroad");
    if (!app) throw new Error("Missing Gumroad integration");
    const list = app.tools.find(({ name }) => name === "list_resource_subscriptions");
    const create = app.tools.find(({ name }) => name === "create_resource_subscription");
    if (!list || !create) throw new Error("Missing Gumroad resource-subscription tools");

    expect(list.query_params).toEqual(["resource_name"]);
    expect(list.input_schema.required).toEqual(["resource_name"]);
    expect(create.method).toBe("PUT");
    expect(create.input_schema.required).toEqual(["resource_name", "post_url"]);
  });

  test("matches Gumroad's current audience-email routes", () => {
    const app = getAppTemplate("gumroad");
    if (!app) throw new Error("Missing Gumroad integration");

    const list = app.tools.find(({ name }) => name === "list_emails");
    const create = app.tools.find(({ name }) => name === "create_email");
    const schedule = app.tools.find(({ name }) => name === "schedule_email");
    const unschedule = app.tools.find(({ name }) => name === "unschedule_email");

    expect(app.tools.some(({ name }) => name === "update_email")).toBe(false);
    expect(list?.query_params).toEqual(["type", "page_key"]);
    expect(create?.input_schema.required).toEqual(["subject", "body"]);
    expect(schedule?.method).toBe("POST");
    expect(schedule?.path).toBe("/emails/{emailId}/schedule");
    expect(schedule?.input_schema.required).toEqual(["emailId", "to_be_published_at"]);
    expect(unschedule?.method).toBe("POST");
    expect(unschedule?.path).toBe("/emails/{emailId}/unschedule");
  });

  test("keeps category selectors mutually exclusive", () => {
    const app = getAppTemplate("gumroad");
    if (!app) throw new Error("Missing Gumroad integration");
    for (const name of ["create_product", "update_product"]) {
      const tool = app.tools.find((candidate) => candidate.name === name);
      expect(tool?.input_schema.not).toEqual({ required: ["category", "taxonomy_id"] });
    }
  });
});
