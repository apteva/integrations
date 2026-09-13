import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const app = getAppTemplate("vultr-object-storage")!;

async function request(name: string, input: Record<string, unknown>, response = new Response("", { status: 200 }), hostname = "ewr1.vultrobjects.com") {
  let url = "";
  let init: RequestInit = {};
  globalThis.fetch = (async (target, options) => {
    url = String(target);
    init = options || {};
    return response;
  }) as typeof fetch;
  const tool = app.tools.find(t => t.name === name)!;
  const result = await executeTool({ app, tool, input, credentials: { fields: {
    s3_hostname: hostname, access_key_id: "test-access-key", secret_access_key: "test-secret-key",
  } } });
  expect(result.success).toBe(true);
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/us-east-1\/s3\/aws4_request,/);
  expect(url).not.toContain("test-secret-key");
  return { url: new URL(url), init, headers, result };
}

test("loads the catalog with S3 credentials and all seven operations", () => {
  expect(app.auth.types).toEqual(["aws_sigv4"]);
  expect(app.tools).toHaveLength(7);
  expect(app.health_check).toEqual({ tool: "list_buckets" });
  expect(app.auth.credential_fields?.map(f => f.name)).toEqual([
    "s3_hostname", "access_key_id", "secret_access_key", "region",
  ]);
});

test("resolves the subscription hostname and sends ListObjectsV2 pagination", async () => {
  const { url, init } = await request("list_objects", {
    bucket: "photos", prefix: "summer/", delimiter: "/", "continuation-token": "a+b/=", "max-keys": 30,
  }, undefined, "ams1.vultrobjects.com");
  expect(url.origin).toBe("https://ams1.vultrobjects.com");
  expect(url.pathname).toBe("/photos");
  expect(url.searchParams.get("list-type")).toBe("2");
  expect(url.searchParams.get("prefix")).toBe("summer/");
  expect(url.searchParams.get("continuation-token")).toBe("a+b/=");
  expect(url.searchParams.get("max-keys")).toBe("30");
  expect(init.body).toBeUndefined();
});

test("uploads exact text bytes and signs their hash without JSON wrapping", async () => {
  const body = 'hello\n"Vultr"';
  const { url, init, headers } = await request("put_object", { bucket: "photos", key: "folder/a b+#.txt", body });
  expect(decodeURIComponent(url.pathname)).toBe("/photos/folder/a b+#.txt");
  expect(url.search).toBe("");
  expect(init.method).toBe("PUT");
  expect(init.body).toBe(body);
  expect(headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(headers.get("x-amz-content-sha256")).toBe(createHash("sha256").update(body).digest("hex"));
});

test("uploads binary bytes and signs the decoded payload", async () => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const { init, headers } = await request("put_object", { bucket: "photos", key: "image.bin", body: {
    _binary: true, base64: bytes.toString("base64"), mimeType: "application/octet-stream",
  } });
  expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes);
  expect(headers.get("content-type")).toBe("application/octet-stream");
  expect(headers.get("x-amz-content-sha256")).toBe(createHash("sha256").update(bytes).digest("hex"));
});

test("downloads binary objects without corrupting bytes", async () => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const { result } = await request("get_object", { bucket: "photos", key: "image.bin" },
    new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  expect(result.data).toMatchObject({ _binary: true, base64: bytes.toString("base64") });
});

test("bucket creation signs an empty payload and deletion has no body", async () => {
  const created = await request("create_bucket", { bucket: "photos" });
  expect(created.init.method).toBe("PUT");
  expect(created.init.body).toBeUndefined();
  expect(created.headers.get("x-amz-content-sha256")).toBe(createHash("sha256").update("").digest("hex"));
  for (const name of ["delete_bucket", "delete_object"]) {
    const { init, url } = await request(name, { bucket: "photos", ...(name === "delete_object" ? { key: "a.txt" } : {}) }, new Response(null, { status: 204 }));
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(url.pathname).toBe(name === "delete_object" ? "/photos/a.txt" : "/photos");
  }
  const listed = await request("list_buckets", {});
  expect(listed.url.pathname).toBe("/");
  expect(listed.init.method).toBe("GET");
});
