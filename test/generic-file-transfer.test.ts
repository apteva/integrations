import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import { generateMcpServer } from "../src/mcp-generator.js";
import type { AppTemplate, AppToolTemplate, Connection } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function definition(slug: string, name: string) {
  const app = getAppTemplate(slug)!;
  const tool = app.tools.find((item) => item.name === name)!;
  if (!tool) throw new Error(`Missing ${slug}.${name}`);
  return { app, tool };
}

function run(slug: string, name: string, input: Record<string, unknown>) {
  return executeTool({ ...definition(slug, name), credentials: { access_token: "test-token" }, input });
}

describe("generic file transfer tools", () => {
  test("Gmail attachment bytes pass unchanged into a Drive media upload", async () => {
    const bytes = Buffer.from([0x00, 0xfb, 0xff, 0x80, 0x0d, 0x0a]);
    const requests: { url: URL; init?: RequestInit }[] = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      if (requests.length === 1) return Response.json({ size: bytes.length, data: bytes.toString("base64url") });
      return Response.json({ id: "drive-file", size: String(bytes.length) });
    };

    const downloaded = await run("gmail", "download_attachment", {
      messageId: "message", attachmentId: "attachment", mimeType: "application/pdf",
    });
    expect(downloaded.success).toBe(true);
    expect(downloaded.data).toEqual({ _binary: true, base64: bytes.toString("base64"), mimeType: "application/pdf", size: bytes.length });
    expect(requests[0].url.search).toBe("");

    const uploaded = await run("google-drive", "upload_file_content", {
      fileId: "drive-file", file: downloaded.data, supportsAllDrives: true, fields: "id,size",
    });
    expect(uploaded.success).toBe(true);
    expect(requests[1].url.pathname).toBe("/upload/drive/v3/files/drive-file");
    expect(requests[1].url.searchParams.get("uploadType")).toBe("media");
    expect(requests[1].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(requests[1].url.searchParams.get("fields")).toBe("id,size");
    expect(requests[1].init?.method).toBe("PATCH");
    expect(new Headers(requests[1].init?.headers).get("Content-Type")).toBe("application/pdf");
    expect(Buffer.from(requests[1].init?.body as Uint8Array)).toEqual(bytes);
  });

  test.each(["application/json", "text/csv", "application/pdf"])("GCS preserves exact %s bytes", async (mimeType) => {
    const bytes = Buffer.from("  {\"value\": 1}\r\n\r\n");
    let downloadURL: URL | undefined;
    globalThis.fetch = async (url) => {
      downloadURL = new URL(String(url));
      return new Response(bytes, { headers: { "content-type": mimeType } });
    };
    const downloaded = await run("google-cloud-storage", "download_object", {
      bucket: "source", object: "folder/report.json", generation: "123", alt: "media",
    });
    expect(downloadURL?.pathname).toBe("/storage/v1/b/source/o/folder%2Freport.json");
    expect(downloadURL?.searchParams.getAll("alt")).toEqual(["media"]);
    expect(downloadURL?.searchParams.get("generation")).toBe("123");
    expect(downloaded.data).toEqual({ _binary: true, base64: bytes.toString("base64"), mimeType, size: bytes.length });
  });

  test("Drive text download keeps whitespace and encoding", async () => {
    const bytes = Buffer.from("one,two\r\n3,4\r\n");
    globalThis.fetch = async () => new Response(bytes, { headers: { "content-type": "text/csv; charset=utf-8" } });
    const result = await run("google-drive", "download_file", { fileId: "csv" });
    expect(result.data).toEqual({ _binary: true, base64: bytes.toString("base64"), mimeType: "text/csv", size: bytes.length });
  });

  test("folder creation sets its MIME type even when omitted or overridden", async () => {
    let request: { url?: URL; body?: unknown } = {};
    globalThis.fetch = async (url, init) => {
      request = { url: new URL(String(url)), body: JSON.parse(String(init?.body)) };
      return Response.json({ id: "folder" });
    };
    for (const mimeType of [undefined, "application/pdf"]) {
      await run("google-drive", "create_folder", { name: "Any folder", parents: ["root"], mimeType, fields: "id", supportsAllDrives: true });
      expect(request.body).toEqual({ mimeType: "application/vnd.google-apps.folder", name: "Any folder", parents: ["root"] });
      expect(request.url?.searchParams.get("fields")).toBe("id");
      expect(request.url?.searchParams.get("supportsAllDrives")).toBe("true");
    }
  });

  test("file creation keeps metadata in JSON and projection options in the query", async () => {
    let url: URL | undefined;
    let body: unknown;
    globalThis.fetch = async (u, init) => {
      url = new URL(String(u)); body = JSON.parse(String(init?.body));
      return Response.json({ id: "preallocated" });
    };
    const metadata = { id: "preallocated", name: "report.pdf", mimeType: "application/pdf", parents: ["folder"], appProperties: { sourceId: "source-1" } };
    await run("google-drive", "create_file_metadata", { ...metadata, fields: "id", supportsAllDrives: true });
    expect(body).toEqual(metadata);
    expect(url?.searchParams.get("fields")).toBe("id");
  });

  test.each(["move_file", "update_file"])("%s sends parent changes in the query", async (name) => {
    let url: URL | undefined;
    let body: unknown;
    globalThis.fetch = async (u, init) => {
      url = new URL(String(u)); body = JSON.parse(String(init?.body));
      return Response.json({ id: "file" });
    };
    await run("google-drive", name, { fileId: "file", addParents: "new", removeParents: "old", supportsAllDrives: true, fields: "id,parents", ...(name === "update_file" ? { name: "renamed.pdf" } : {}) });
    expect(url?.searchParams.get("addParents")).toBe("new");
    expect(url?.searchParams.get("removeParents")).toBe("old");
    expect(body).toEqual(name === "update_file" ? { name: "renamed.pdf" } : {});
  });

  test("download errors preserve provider error responses", async () => {
    globalThis.fetch = async () => Response.json({ error: { message: "Access denied" } }, { status: 403 });
    for (const [slug, name, input] of [
      ["gmail", "download_attachment", { messageId: "message", attachmentId: "attachment" }],
      ["google-cloud-storage", "download_object", { bucket: "bucket", object: "file" }],
    ] as const) {
      const result = await run(slug, name, input);
      expect(result.success).toBe(false);
      expect(result.status).toBe(403);
      expect(result.data).toEqual({ error: { message: "Access denied" } });
    }
  });

  test("binary response transforms work with any JSON provider and reject corrupt data", async () => {
    const { app, tool } = definition("gmail", "download_attachment");
    const genericApp: AppTemplate = { ...app, slug: "generic-files" };
    const genericTool: AppToolTemplate = { ...tool, response_transform: { type: "base64_to_binary", source: "payload.bytes", encoding: "base64" } };
    for (const encoded of ["APv/", "APv/AA==", "APv/AA", ""]) {
      globalThis.fetch = async () => Response.json({ payload: { bytes: encoded } });
      const result = await executeTool({ app: genericApp, tool: genericTool, credentials: {}, input: {} });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ _binary: true, base64: Buffer.from(encoded, "base64").toString("base64"), mimeType: "application/octet-stream" });
    }
    for (const encoded of ["A", "???", "AA=", "AB=="]) {
      globalThis.fetch = async () => Response.json({ payload: { bytes: encoded } });
      const result = await executeTool({ app: genericApp, tool: genericTool, credentials: {}, input: {} });
      expect(result.success).toBe(false);
    }
    globalThis.fetch = async () => Response.json({ payload: { bytes: "AAECAw==" } });
    const tooLarge = await executeTool({ app: genericApp, tool: genericTool, credentials: {}, input: {}, maxBinaryBytes: 3 });
    expect(tooLarge.success).toBe(false);
  });

  test("required binary uploads reject missing or malformed payloads before requesting", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    for (const file of [undefined, "plain text", { _binary: true, base64: "???" }]) {
      await expect(run("google-drive", "upload_file_content", { fileId: "file", file })).rejects.toThrow();
    }
    expect(requests).toBe(0);
  });

  test("generated descriptors retain generic download and upload options", () => {
    const app = getAppTemplate("google-drive")!;
    const connection = { id: "test", credentials: {}, app_slug: app.slug } as Connection;
    const generated = generateMcpServer(connection, app);
    expect(generated.tools.find((tool) => tool.name === "google-drive_upload_file_content")?.http_config)
      .toMatchObject({ body_binary_param: "file", query_params: ["fields", "supportsAllDrives"] });
    expect(generated.tools.find((tool) => tool.name === "google-drive_download_file")?.http_config.response_type).toBe("binary");
  });
});
