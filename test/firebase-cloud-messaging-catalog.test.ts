import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Firebase for Android & FCM integration", () => {
  test("uses Google OAuth for new connections while retaining hidden legacy credentials", () => {
    const app = getAppTemplate("firebase-cloud-messaging");
    expect(app).toBeDefined();
    expect(app?.name).toBe("Firebase for Android & FCM");
    expect(app?.base_url).toBe("https://firebase.googleapis.com");
    expect(app?.auth.types).toEqual(["oauth2"]);
    expect(app?.auth.headers?.Authorization).toBe("Bearer {{token}}");
    expect(app?.auth.signers).toEqual([
      {
        name: "google_service_account",
        params: { scope: "https://www.googleapis.com/auth/cloud-platform" },
      },
    ]);
    expect(app?.auth.oauth2).toMatchObject({
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      client_id_required: true,
      pkce: false,
      extra_authorize_params: {
        access_type: "offline",
        prompt: "consent select_account",
        include_granted_scopes: "true",
      },
    });
    expect(app?.auth.oauth2?.scopes).toEqual([
      "https://www.googleapis.com/auth/firebase",
      "https://www.googleapis.com/auth/firebase.messaging",
      "https://www.googleapis.com/auth/cloud-platform",
    ]);

    expect(
      app?.auth.credential_fields?.find(
        (field) => field.name === "service_account_json",
      ),
    ).toMatchObject({
      type: "multiline_password",
      source: "user",
      hidden: true,
      required: false,
    });
    expect(
      app?.auth.credential_fields?.find(
        (field) => field.name === "refresh_token",
      ),
    ).toMatchObject({ source: "oauth", hidden: true, required: false });
    expect(
      app?.auth.credential_fields?.find(
        (field) => field.name === "relay_encryption_key",
      ),
    ).toMatchObject({ source: "generated", hidden: true, required: false });
    expect(app?.health_check).toEqual({
      tool: "list_projects",
      input: { pageSize: 1 },
    });
  });

  test("declares the management and delivery routes without duplicate tools", () => {
    const app = getAppTemplate("firebase-cloud-messaging");
    if (!app) throw new Error("Missing Firebase integration");

    expect(app.tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "list_android_apps",
      "create_android_app",
      "get_android_config",
      "get_operation",
      "list_android_sha",
      "add_android_sha",
      "send_message",
    ]);
    expect(new Set(app.tools.map((tool) => tool.name)).size).toBe(8);

    const routes = Object.fromEntries(
      app.tools.map((tool) => [tool.name, `${tool.method} ${tool.path}`]),
    );
    expect(routes).toEqual({
      list_projects: "GET /v1beta1/projects",
      list_android_apps: "GET /v1beta1/projects/{project_id}/androidApps",
      create_android_app: "POST /v1beta1/projects/{project_id}/androidApps",
      get_android_config:
        "GET /v1beta1/projects/{project_id}/androidApps/{app_id}/config",
      get_operation: "GET /v1beta1/operations/{operation_id}",
      list_android_sha:
        "GET /v1beta1/projects/{project_id}/androidApps/{app_id}/sha",
      add_android_sha:
        "POST /v1beta1/projects/{project_id}/androidApps/{app_id}/sha",
      send_message: "POST /v1/projects/{project_id}/messages:send",
    });

    const listProjects = app.tools.find((tool) => tool.name === "list_projects")!;
    expect(listProjects.query_params).toEqual([
      "pageSize",
      "pageToken",
      "showDeleted",
    ]);
    const create = app.tools.find((tool) => tool.name === "create_android_app")!;
    expect(create.input_schema.required).toEqual(["project_id", "packageName"]);
    expect(create.input_schema.properties).toMatchObject({
      packageName: { type: "string" },
      displayName: { type: "string" },
      apiKeyId: { type: "string" },
    });
    const addSha = app.tools.find((tool) => tool.name === "add_android_sha")!;
    expect(addSha.input_schema.properties?.certType).toMatchObject({
      enum: ["SHA_1", "SHA_256"],
    });
    const send = app.tools.find((tool) => tool.name === "send_message")!;
    expect(send.base_url).toBe("https://fcm.googleapis.com");
    expect(send.input_schema.required).toEqual(["project_id", "message"]);
    expect(send.input_schema.properties?.message.properties).toMatchObject({
      fid: { type: "string" },
      token: { type: "string" },
      topic: { type: "string" },
      condition: { type: "string" },
    });
  });

  test("sends OAuth requests to the correct per-tool hosts", async () => {
    const app = getAppTemplate("firebase-cloud-messaging");
    if (!app) throw new Error("Missing Firebase integration");
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await executeTool({
      app,
      tool: app.tools.find((tool) => tool.name === "list_projects")!,
      credentials: { fields: { access_token: "oauth-token" } },
      input: { pageSize: 25, pageToken: "next", showDeleted: false },
    });
    await executeTool({
      app,
      tool: app.tools.find((tool) => tool.name === "send_message")!,
      credentials: { fields: { access_token: "oauth-token" } },
      input: {
        project_id: "firebase-project",
        message: {
          fid: "installation-id",
          data: { type: "test" },
          android: { priority: "high" },
        },
        validate_only: true,
      },
    });

    expect(requests[0]?.url).toBe(
      "https://firebase.googleapis.com/v1beta1/projects?pageSize=25&pageToken=next&showDeleted=false",
    );
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
      "Bearer oauth-token",
    );
    expect(requests[1]?.url).toBe(
      "https://fcm.googleapis.com/v1/projects/firebase-project/messages:send",
    );
    expect(new Headers(requests[1]?.init?.headers).get("Authorization")).toBe(
      "Bearer oauth-token",
    );
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      message: {
        fid: "installation-id",
        data: { type: "test" },
        android: { priority: "high" },
      },
      validate_only: true,
    });
  });

  test("marks the separate placeholder Firebase catalog as legacy", () => {
    const legacy = getAppTemplate("firebase");
    expect(legacy?.name).toBe("Firebase (Legacy)");
    expect(legacy?.categories).toContain("legacy");
  });
});
