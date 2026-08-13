import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

function quote3d() {
  const app = getAppTemplate("quote3d");
  if (!app) throw new Error("Missing Quote3D integration");
  return app;
}

function tool(name: string) {
  const result = quote3d().tools.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing Quote3D tool: ${name}`);
  return result;
}

describe("Quote3D catalog", () => {
  test("covers the useful v2 routes without semantic duplicates", () => {
    const app = quote3d();
    expect(app.tools).toHaveLength(25);
    expect(new Set(app.tools.map(({ name }) => name)).size).toBe(app.tools.length);
    expect(new Set(app.tools.map(({ method, path }) => `${method} ${path}`)).size).toBe(
      app.tools.length,
    );
    expect(app.tools.some(({ path }) => path.endsWith("/async"))).toBe(false);
    expect(app.tools.every(({ input_schema }) => !input_schema.properties?.body)).toBe(true);
  });

  test("temporary upload sends multipart bytes without leaking the bearer token", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: BodyInit | null | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ success: true, data: { fileId: "file-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: quote3d(),
        tool: tool("upload_file_with_id"),
        credentials: { api_key: "secret-token" },
        input: {
          upload_id: "upload-1",
          file: Buffer.from("solid cube\nendsolid cube\n").toString("base64"),
          filename: "cube.stl",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedUrl).toBe("https://api.quote3d.com/v2/file/public/upload-1");
    expect(capturedHeaders).not.toHaveProperty("Authorization");
    const uploaded = (capturedBody as FormData).get("file") as File;
    expect(uploaded.name).toBe("cube.stl");
    expect(await uploaded.text()).toBe("solid cube\nendsolid cube\n");
  });

  test("quote route preserves typed nested profile overrides", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      capturedBody = String(init?.body || "");
      return new Response(JSON.stringify({ success: true, data: { jobId: "job-1" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await executeTool({
        app: quote3d(),
        tool: tool("create_quote"),
        credentials: { api_key: "secret-token" },
        input: {
          file_id: "file-1",
          printer_id: "printer-1",
          quantity: 2,
          material_config: { filament_type: "PETG", color: "Black" },
          quote_config: { currency: "EUR", fixed_fee: 3.5 },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedUrl).toBe("https://api.quote3d.com/v2/file/quote/file-1");
    expect(capturedHeaders).toMatchObject({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(capturedBody)).toEqual({
      printer_id: "printer-1",
      quantity: 2,
      material_config: { filament_type: "PETG", color: "Black" },
      quote_config: { currency: "EUR", fixed_fee: 3.5 },
    });
  });
});
