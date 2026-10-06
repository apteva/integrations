import { expect, test } from "bun:test";
import heygen from "../src/apps/heygen.json";
import { executeTool } from "../src/http-executor";
import type { AppTemplate, AppToolTemplate } from "../src/types";

function tool(name: string) {
  const found = heygen.tools.find(t => t.name === name);
  if (!found) throw new Error(`Missing HeyGen tool ${name}`);
  return found as AppToolTemplate;
}

type Captured = { url: URL; method: string; headers: Headers; body: string; form?: FormData };
async function withProvider(run: (execute: (name: string, input?: Record<string, unknown>) => ReturnType<typeof executeTool>, requests: Captured[]) => Promise<void>, response: unknown = { data: { id: "resource", status: "pending" } }, status = 200) {
  const requests: Captured[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const multipart = req.headers.get("content-type")?.startsWith("multipart/form-data");
    requests.push({ url: new URL(req.url), method: req.method, headers: req.headers, body: await req.clone().text(), form: multipart ? await req.formData() : undefined });
    return Response.json(response, { status });
  } });
  try {
    await run((name, input = {}) => executeTool({ app: { ...heygen, base_url: `http://127.0.0.1:${server.port}` } as AppTemplate, tool: tool(name), credentials: { fields: { api_key: "test-heygen-key" } }, input }), requests);
    for (const request of requests) expect(request.headers.get("X-Api-Key")).toBe("test-heygen-key");
  } finally { server.stop(true); }
}

test("HeyGen catalog is synced, v3-only, and exposes native required fields", async () => {
  expect(await Bun.file("../server/integrations-catalog/heygen.json").text()).toBe(await Bun.file("src/apps/heygen.json").text());
  expect(new Set(heygen.tools.map(t => t.name)).size).toBe(heygen.tools.length);
  for (const t of heygen.tools) expect(t.path.startsWith("/v3/")).toBe(true);
  expect(JSON.stringify(heygen)).not.toContain('"$ref"');
  expect(heygen.health_check.tool).toBe("get_current_user");
  expect(tool("get_current_user").path).toBe("/v3/users/me");
  expect(tool("generate_studio_video").input_schema.required).toEqual(["scenes"]);
  expect(tool("generate_studio_video").input_schema.properties).toHaveProperty("title");
  expect(tool("generate_studio_video").input_schema.properties).not.toHaveProperty("video_inputs");
  expect(tool("create_webm_video").input_schema.properties).not.toHaveProperty("background");
  expect(tool("generate_from_template").input_schema.required).toContain("variables");
  expect(tool("add_looks_to_photo_avatar_group").input_schema.required).toContain("avatar_group_id");
  for (const name of ["list_voice_locales", "train_photo_avatar_group", "add_photo_avatar_motion", "list_folders", "update_folder", "trash_folder", "restore_folder"]) expect(heygen.tools.some(t => t.name === name)).toBe(false);
  expect(heygen.webhooks.signature_header).toBe("signature");
  expect(heygen.webhooks.registration.response_secret_field).toBe("data.secret");
  expect(heygen.webhooks.registration.path).toBe("/v3/webhooks/endpoints");
});

test("Studio and WebM helpers send native JSON and put idempotency only in the header", async () => {
  await withProvider(async (execute, requests) => {
    const studio = { title: "Monthly update", scenes: [{ type: "avatar_video", input: { type: "avatar", avatar_id: "avatar", script: "Hello", voice_id: "voice" } }], aspect_ratio: "16:9" };
    await execute("generate_studio_video", { ...studio, idempotency_key: "studio:1", type: "avatar", video_inputs: [] });
    expect(JSON.parse(requests[0].body)).toEqual({ type: "studio", ...studio });
    expect(requests[0].headers.get("Idempotency-Key")).toBe("studio:1");
    const webm = { avatar_id: "avatar", script: "Hello" };
    await execute("create_webm_video", { ...webm, output_format: "mp4", background: { type: "color", value: "#fff" } });
    expect(JSON.parse(requests[1].body)).toEqual({ type: "avatar", output_format: "webm", ...webm });
    for (const r of requests) { expect(r.method).toBe("POST"); expect(r.url.pathname).toBe("/v3/videos"); expect(r.url.search).toBe(""); }
  });
});

test("Translations, templates and proofread replacement preserve typed asset inputs", async () => {
  await withProvider(async (execute, requests) => {
    const translation = { video: { type: "url", url: "https://example.com/video.mp4" }, output_languages: ["Spanish"], title: "Translated" };
    await execute("translate_video", translation);
    expect(JSON.parse(requests[0].body)).toEqual(translation);
    await execute("generate_from_template", { template_id: "template", variables: { greeting: { type: "text", properties: { content: "Hola" } } } });
    expect(requests[1].url.pathname).toBe("/v3/templates/template");
    expect(JSON.parse(requests[1].body)).not.toHaveProperty("template_id");
    const srt = { type: "url", url: "https://example.com/corrected.srt" };
    await execute("upload_proofread_srt", { proofread_id: "proof", srt });
    expect([requests[2].method, requests[2].url.pathname]).toEqual(["PUT", "/v3/video-translations/proofreads/proof/srt"]);
    expect(JSON.parse(requests[2].body)).toEqual({ srt });
    expect(tool("upload_proofread_srt").header_params).toBeUndefined();
  });
});

test("Avatar creation fixes discriminators and twin consent is a separate request", async () => {
  await withProvider(async (execute, requests) => {
    for (const [name, type, extra] of [["create_photo_avatar", "prompt", { prompt: "A presenter" }], ["create_photo_avatar_group", "photo", { file: { type: "asset_id", asset_id: "photo" } }], ["create_digital_twin", "digital_twin", { file: { type: "url", url: "https://example.com/footage.mp4" } }]] as const) {
      await execute(name, { name: "Presenter", ...extra, type: "wrong" });
      expect(JSON.parse(requests.at(-1)!.body)).toEqual({ type, name: "Presenter", ...extra });
      expect(requests.at(-1)!.url.pathname).toBe("/v3/avatars");
    }
    await execute("create_avatar_consent", { group_id: "group", consent_video: { type: "asset_id", asset_id: "consent" } });
    expect(requests[3].url.pathname).toBe("/v3/avatars/group/consent");
    expect(JSON.parse(requests[3].body)).toEqual({ consent_video: { type: "asset_id", asset_id: "consent" } });
  });
});

test("HeyGen asset upload sends exact binary bytes in multipart", async () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  await withProvider(async (execute, requests) => {
    await execute("upload_asset", { file: `data:image/png;base64,${bytes.toString("base64")}`, idempotency_key: "asset:1" });
    const r = requests[0];
    expect(r.url.pathname).toBe("/v3/assets");
    expect(r.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
    expect(r.headers.get("Idempotency-Key")).toBe("asset:1");
    expect(Array.from(r.form!.keys())).toEqual(["file"]);
    const file = r.form!.get("file") as File;
    expect(r.body).toContain("Content-Type: image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
  });
});

test("Webhook paths and cursor pagination preserve full native responses", async () => {
  const response = { data: [{ endpoint_id: "endpoint", secret: null }], has_more: true, next_token: "opaque +/=" };
  await withProvider(async (execute, requests) => {
    expect((await execute("list_webhook_endpoints", { token: "opaque +/=", limit: 10 })).data).toEqual(response);
    expect(requests[0].url.searchParams.get("token")).toBe("opaque +/=");
    await execute("update_webhook_endpoint", { endpoint_id: "endpoint", events: ["avatar_video.success"] });
    expect([requests[1].method, requests[1].url.pathname]).toEqual(["PATCH", "/v3/webhooks/endpoints/endpoint"]);
    expect(JSON.parse(requests[1].body)).toEqual({ events: ["avatar_video.success"] });
    await execute("delete_webhook_endpoint", { endpoint_id: "endpoint" });
    expect([requests[2].method, requests[2].url.pathname]).toEqual(["DELETE", "/v3/webhooks/endpoints/endpoint"]);
    expect(requests[2].body).toBe("");
    await execute("rotate_webhook_signing_secret", { endpoint_id: "endpoint" });
    expect([requests[3].method, requests[3].url.pathname, requests[3].body]).toEqual(["POST", "/v3/webhooks/endpoints/endpoint/rotate-secret", ""]);
  }, response);
});

test("Billable HeyGen mutations return provider failure without an automatic retry", async () => {
  await withProvider(async (execute, requests) => {
    const response = await execute("create_webm_video", { avatar_id: "avatar", script: "Hello", idempotency_key: "video:1" });
    expect(response.success).toBe(false);
    expect(response.status).toBe(409);
    expect(response.data).toEqual({ error: { message: "Request in progress" } });
    expect(requests).toHaveLength(1);
  }, { error: { message: "Request in progress" } }, 409);
});
