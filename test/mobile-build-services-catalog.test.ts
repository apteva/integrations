import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const slugs = ["expo-eas", "xcode-cloud", "capawesome-cloud", "capgo-build"];

function app(slug: string): AppTemplate {
  const found = getAppTemplate(slug);
  if (!found) throw new Error(`Missing integration ${slug}`);
  return found;
}

function tool(slug: string, name: string): AppToolTemplate {
  const found = app(slug).tools.find(t => t.name === name);
  if (!found) throw new Error(`Missing ${slug}/${name}`);
  return found;
}

type Request = { url: string; init: RequestInit; headers: Headers; body?: any };

async function capture(
  slug: string, name: string, input: Record<string, unknown>,
  response: Response, fields: Record<string, string> = { token: "test-token", api_key: "test-capgo-key" },
) {
  let request: Request | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init: init || {}, headers: new Headers(init?.headers) };
    if (typeof init?.body === "string") request.body = JSON.parse(init.body);
    return response;
  };
  try {
    const result = await executeTool({ app: app(slug), tool: tool(slug, name), credentials: { fields }, input });
    if (!request) throw new Error("Expected HTTP request");
    return { request, result };
  } finally {
    globalThis.fetch = original;
  }
}

describe("mobile build service catalogs", () => {
  test("loads all four and has complete route inputs and read-only health probes", () => {
    for (const slug of slugs) {
      const integration = app(slug);
      const health = integration.health_check!;
      const probe = tool(slug, health.tool!);
      for (const required of (probe.input_schema.required || []) as string[]) {
        expect(health.input).toHaveProperty(required);
      }
      if (slug === "expo-eas") {
        expect(probe.request_transform?.type).toBe("json_wrap");
        expect((probe.request_transform as any).constants.query).toStartWith("query ");
      } else {
        expect(probe.method).toBe("GET");
      }
      for (const candidate of integration.tools) {
        for (const match of candidate.path.matchAll(/\{([^}]+)\}/g)) {
          expect(candidate.input_schema.properties).toHaveProperty(match[1]);
          expect(candidate.input_schema.required).toContain(match[1]);
        }
      }
    }
  });

  test("Expo sends a GraphQL query with typed variables and preserves empty result lists", async () => {
    const input = { appId: "project-id", limit: 5, offset: 0, filter: { platform: "IOS", status: "FINISHED" } };
    const { request, result } = await capture("expo-eas", "list_builds", input, Response.json({ data: { app: { byId: { builds: [] } } } }));
    expect(request.url).toBe("https://api.expo.dev/graphql");
    expect(request.init.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    expect(request.body.variables).toEqual(input);
    expect(request.body.query).toContain("builds(limit: $limit, offset: $offset, filter: $filter)");
    expect(Object.keys(request.body).sort()).toEqual(["query", "variables"]);
    expect(result).toMatchObject({ success: true, data: [] });
  });

  test("Expo build mutations pass prepared jobs without inventing profile-only REST routes", async () => {
    for (const [platform, type] of [["android", "Android"], ["ios", "Ios"]]) {
      const job = { type: "GENERIC", projectRootDirectory: ".", projectArchive: { type: "URL", url: "https://source.example/project.tar.gz" } };
      const mutation = `create${type}Build`;
      const { request, result } = await capture("expo-eas", `create_${platform}_build`, { appId: "project-id", job }, Response.json({ data: { build: { [mutation]: { build: { id: "build-id", status: "NEW" } } } } }));
      expect(request.url).toBe("https://api.expo.dev/graphql");
      expect(request.body.variables).toEqual({ appId: "project-id", job });
      expect(request.body.query).toContain(`$job: ${type}JobInput!`);
      expect(result).toMatchObject({ success: true, data: { build: { id: "build-id" } } });
      expect(tool("expo-eas", `create_${platform}_build`).input_schema.properties.job.required).toEqual(expect.arrayContaining(["type", "projectArchive", "projectRootDirectory"]));
    }
  });

  test("Expo starts a Git-backed workflow revision with JSON inputs", async () => {
    const input = { workflowRevisionId: "revision-id", gitRef: "main", inputs: { profile: "production" } };
    const { request, result } = await capture("expo-eas", "start_workflow", input, Response.json({ data: { workflowRun: { createWorkflowRunFromGitRef: { id: "run-id" } } } }));
    expect(request.body.variables).toEqual(input);
    expect(request.body.query).toContain("createWorkflowRunFromGitRef(");
    expect(result).toMatchObject({ success: true, data: { id: "run-id" } });
  });

  test("Expo treats GraphQL errors in HTTP 200 as failures before extracting partial data", async () => {
    const { result } = await capture("expo-eas", "get_build", { buildId: "missing" }, Response.json({ errors: [{ message: "Not authorized", extensions: { errorCode: "UNAUTHORIZED" } }], data: { builds: { byId: null } } }));
    expect(result).toMatchObject({ success: false, status: 200, data: { error: "upstream_graphql_error", message: "Not authorized" } });
  });

  test("Xcode Cloud signs with the existing Apple signer and sends JSON:API relationship IDs", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { request, result } = await capture("xcode-cloud", "start_build", { workflow_id: "workflow-id", git_reference_id: "git-id", clean: false }, Response.json({ data: { type: "ciBuildRuns", id: "run-id" } }), { issuer_id: "issuer-id", key_id: "KEY123", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    expect(request.url).toBe("https://api.appstoreconnect.apple.com/v1/ciBuildRuns");
    expect(request.body).toEqual({ data: { type: "ciBuildRuns", attributes: { clean: false }, relationships: { workflow: { data: { type: "ciWorkflows", id: "workflow-id" } }, sourceBranchOrTag: { data: { type: "scmGitReferences", id: "git-id" } } } } });
    const jwt = request.headers.get("authorization")!.replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: "issuer-id", aud: "appstoreconnect-v1" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
    expect(result.success).toBe(true);
  });

  test("Xcode rebuilds link an existing run rather than inventing cancel/retry endpoints", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { request } = await capture("xcode-cloud", "rebuild", { build_run_id: "old-run", clean: true }, Response.json({ data: { id: "new-run" } }), { issuer_id: "issuer", key_id: "KEY123", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    expect(request.body).toEqual({ data: { type: "ciBuildRuns", attributes: { clean: true }, relationships: { buildRun: { data: { type: "ciBuildRuns", id: "old-run" } } } } });
  });

  test("Xcode sends comma-separated Apple filters and opaque pagination cursors", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { request } = await capture("xcode-cloud", "list_products", { "filter[app]": "app1,app2", limit: 5, cursor: "opaque+token" }, Response.json({ data: [] }), { issuer_id: "issuer", key_id: "KEY123", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const url = new URL(request.url);
    expect(url.searchParams.getAll("filter[app]")).toEqual(["app1,app2"]);
    expect(url.searchParams.get("cursor")).toBe("opaque+token");
    expect(request.init.body).toBeUndefined();
  });

  test("Capawesome starts a build with source, signing, environment, and store references", async () => {
    const input = { appId: "app-id", platform: "ios", type: "app-store", gitRef: "main", stack: "macos-tahoe", appCertificateId: "cert-id", appEnvironmentId: "env-id", appDestinationId: "destination-id", adHocEnvironmentVariables: { RELEASE: "true" } };
    const { request, result } = await capture("capawesome-cloud", "start_build", input, Response.json({ id: "build-id", status: "queued" }));
    const { appId, ...body } = input;
    expect(request.url).toBe("https://api.cloud.capawesome.io/v1/apps/app-id/builds");
    expect(request.body).toEqual(body);
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    expect(result.success).toBe(true);
  });

  test("Capawesome keeps organization query inputs outside the create-app body", async () => {
    const { request } = await capture("capawesome-cloud", "create_app", { name: "My app", type: "capacitor", organizationId: "org-id" }, Response.json({ id: "app-id" }));
    expect(request.url).toBe("https://api.cloud.capawesome.io/v1/apps?organizationId=org-id");
    expect(request.body).toEqual({ name: "My app", type: "capacitor" });
  });

  test("Capgo requests a pending build with current signing field names", async () => {
    const input = { app_id: "com.example.app", platform: "android", build_mode: "release", build_options: { outputUploadEnabled: true }, build_credentials: { ANDROID_KEYSTORE_FILE: "base64-keystore", KEYSTORE_KEY_ALIAS: "release" }, cache_enabled: false };
    const { request } = await capture("capgo-build", "request_build", input, Response.json({ job_id: "job-id", status: "pending" }));
    expect(request.url).toBe("https://api.capgo.app/build/request");
    expect(request.headers.get("authorization")).toBe("test-capgo-key");
    expect(request.body).toEqual(input);
    expect(request.body.credentials).toBeUndefined();
  });

  test("Capgo creates a TUS upload with an empty body and exposes its response headers", async () => {
    const { request, result } = await capture("capgo-build", "create_source_upload", { job_id: "job-id", upload_length: 3, upload_metadata: "filetype YXBwbGljYXRpb24vemlw" }, new Response(null, { status: 201, headers: { Location: "https://api.capgo.app/build/upload/job-id/source.zip", "Upload-Offset": "0" } }));
    expect(request.init.body).toBeUndefined();
    expect(request.headers.get("tus-resumable")).toBe("1.0.0");
    expect(request.headers.get("upload-length")).toBe("3");
    expect(request.headers.get("content-type")).toBeNull();
    expect(result.headers.location).toBe("https://api.capgo.app/build/upload/job-id/source.zip");
    expect(result.headers["upload-offset"]).toBe("0");
  });

  test("Capgo sends raw upload chunks with TUS offsets and content type", async () => {
    const { request, result } = await capture("capgo-build", "upload_source_chunk", { job_id: "job-id", upload_resource: "source.zip", upload_offset: 0, data: { _binary: true, base64: "AQID", mimeType: "application/offset+octet-stream" } }, new Response(null, { status: 204, headers: { "Upload-Offset": "3" } }));
    expect(request.url).toBe("https://api.capgo.app/build/upload/job-id/source.zip");
    expect(request.init.method).toBe("PATCH");
    expect(request.headers.get("content-type")).toBe("application/offset+octet-stream");
    expect(request.headers.get("upload-offset")).toBe("0");
    expect(Array.from(request.init.body as Uint8Array)).toEqual([1, 2, 3]);
    expect(result.headers["upload-offset"]).toBe("3");
  });

  test("Capgo separates starting compilation from status polling", async () => {
    const started = await capture("capgo-build", "start_build", { job_id: "job-id", app_id: "com.example.app" }, Response.json({ status: "running", logs_url: "https://logs.example/stream" }));
    expect(started.request.url).toBe("https://api.capgo.app/build/start/job-id");
    expect(started.request.body).toEqual({ app_id: "com.example.app" });
    const polled = await capture("capgo-build", "get_build_status", { job_id: "job-id", app_id: "com.example.app", platform: "android" }, Response.json({ status: "completed", upload_url: "https://source.example/upload" }));
    const url = new URL(polled.request.url);
    expect(url.pathname).toBe("/build/status");
    expect(url.searchParams.get("job_id")).toBe("job-id");
    expect(url.searchParams.get("app_id")).toBe("com.example.app");
    expect(url.searchParams.get("platform")).toBe("android");
    expect(polled.request.init.body).toBeUndefined();
  });

  test("all four download tools keep service credentials off artifact hosts", async () => {
    for (const [slug, name] of [["expo-eas", "download_build_artifact"], ["xcode-cloud", "download_artifact"], ["capawesome-cloud", "download_artifact"], ["capgo-build", "download_build_output"]]) {
      const { request, result } = await capture(slug, name, { download_url: "https://artifacts.example/build.zip?signature=abc" }, new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/zip" } }));
      expect(request.url).toBe("https://artifacts.example/build.zip?signature=abc");
      expect(request.headers.get("authorization")).toBeNull();
      expect(result).toMatchObject({ success: true, data: { _binary: true, base64: "AQID" } });
    }
  });
});
