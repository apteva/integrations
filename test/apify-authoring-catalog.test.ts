import { expect, test } from "bun:test";
import apify from "../src/apps/apify.json";
import { getAppTemplate } from "../src/apps/index";
import { executeTool } from "../src/http-executor";
import { generateMcpServer } from "../src/mcp-generator";
import type { AppTemplate, AppToolTemplate, Connection } from "../src/types";

type Request = { url: URL; method: string; headers: Headers; body: string };

async function withApify(
  run: (
    execute: (name: string, input: Record<string, unknown>) => ReturnType<typeof executeTool>,
    requests: Request[],
  ) => Promise<void>,
  response: unknown = { data: { id: "actor-123", status: "READY" } },
  status = 200,
) {
  const requests: Request[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({ url: new URL(req.url), method: req.method, headers: req.headers, body: await req.text() });
      return typeof response === "string"
        ? new Response(response, { status, headers: { "Content-Type": "text/plain" } })
        : Response.json(response, { status });
    },
  });
  try {
    await run((name, input) => {
      const tool = apify.tools.find(tool => tool.name === name);
      if (!tool) throw new Error(`Missing Apify tool ${name}`);
      return executeTool({
        app: { ...apify, base_url: `http://127.0.0.1:${server.port}/v2` } as AppTemplate,
        tool: tool as AppToolTemplate,
        credentials: { fields: { apiToken: "test-apify-token" } },
        input,
      });
    }, requests);
    for (const req of requests) {
      expect(req.headers.get("Authorization")).toBe("Bearer test-apify-token");
      expect(req.url.searchParams.has("token")).toBe(false);
    }
  } finally {
    server.stop(true);
  }
}

const version = {
  versionNumber: "0.1",
  sourceType: "SOURCE_FILES",
  sourceFiles: [
    { name: "src", folder: true },
    { name: "src/main.js", format: "TEXT", content: "import { Actor } from 'apify';\nawait Actor.init();" },
    { name: "README.md", format: "TEXT", content: "# Example actor\nInput and output documentation." },
    { name: "icon.png", format: "BASE64", content: "aWNvbg==" },
  ],
  envVars: [{ name: "SERVICE_SECRET", value: "test-secret", isSecret: true }],
  buildTag: "latest",
  applyEnvVarsToBuild: false,
};

test("Apify authoring preserves source files, secret flags and literal source text", async () => {
  const actor = { name: "example-actor", isPublic: false, versions: [version], defaultRunOptions: { memoryMbytes: 512, restartOnError: false } };
  await withApify(async (execute, requests) => {
    expect((await execute("create_actor", actor)).success).toBe(true);
    expect((await execute("create_actor_version", { actorId: "my-user~example-actor", ...version })).success).toBe(true);
    const { versionNumber, ...changes } = version;
    expect((await execute("update_actor_version", { actorId: "my-user~example-actor", versionNumber, ...changes })).success).toBe(true);
    expect(requests.map(req => [req.method, req.url.pathname, JSON.parse(req.body)])).toEqual([
      ["POST", "/v2/actors", actor],
      ["POST", "/v2/actors/my-user~example-actor/versions", version],
      ["PUT", "/v2/actors/my-user~example-actor/versions/0.1", changes],
    ]);
    for (const req of requests) {
      expect(req.url.search).toBe("");
      expect(req.headers.get("Content-Type")).toBe("application/json");
    }
  }, undefined, 201);
});

test("Apify publication/pricing uses Actor PUT and preserves native records and tag removal", async () => {
  const changes = {
    isPublic: true,
    title: "Example Actor",
    categories: ["DEVELOPER_TOOLS"],
    actorPermissionLevel: "LIMITED_PERMISSIONS",
    taggedBuilds: { latest: { buildId: "successful-build" }, beta: null },
    pricingInfos: [{
      pricingModel: "PAY_PER_EVENT",
      apifyMarginPercentage: 0.2,
      createdAt: "2026-10-01T00:00:00Z",
      startedAt: "2026-10-17T00:00:00Z",
      pricingPerEvent: { actorChargeEvents: {
        "apify-default-dataset-item": { eventTitle: "Result", eventDescription: "One dataset result", eventPriceUsd: 0.001, isPrimaryEvent: true },
        custom: { eventTitle: "Analysis", eventDescription: "One analysis", eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.002 } } },
      } },
      minimalMaxTotalChargeUsd: null,
    }],
  };
  const response = { data: { id: "actor-123", ...changes, stats: { totalRuns: 5 }, taggedBuilds: { latest: { buildId: "successful-build", buildNumber: "0.1.10" } } } };
  await withApify(async (execute, requests) => {
    const result = await execute("update_actor", { actorId: "actor-123", ...changes });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(response);
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].url.pathname).toBe("/v2/actors/actor-123");
    expect(requests[0].url.search).toBe("");
    expect(JSON.parse(requests[0].body)).toEqual(changes);
  }, response);
});

test("Apify builds send query options with zero-byte bodies and preserve transitional status", async () => {
  const response = { data: { id: "build-123", status: "RUNNING", buildNumber: "0.1.11", usageTotalUsd: 0.01 } };
  await withApify(async (execute, requests) => {
    const options = { version: "0.1", useCache: false, betaPackages: true, tag: "beta & latest", waitForFinish: 60 };
    const result = await execute("build_actor", { actorId: "my-user~example-actor", ...options });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(response);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url.pathname).toBe("/v2/actors/my-user~example-actor/builds");
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual(Object.fromEntries(Object.entries(options).map(([key, value]) => [key, String(value)])));
    expect(requests[0].body).toBe("");
    expect((await execute("abort_build", { buildId: "build-123" })).success).toBe(true);
    expect(requests[1].url.pathname).toBe("/v2/actor-builds/build-123/abort");
    expect(requests[1].body).toBe("");
  }, response);
});

test("Apify supports version/build reads, pagination, input validation and plain-text logs", async () => {
  await withApify(async (execute, requests) => {
    await execute("list_actor_versions", { actorId: "actor-123" });
    await execute("get_actor_version", { actorId: "actor-123", versionNumber: "0.1" });
    await execute("list_actor_builds", { actorId: "actor-123", offset: 1000, limit: 1000, desc: true });
    await execute("get_build", { buildId: "build-123", waitForFinish: 60 });
    expect(requests.map(req => [req.method, req.url.pathname, Object.fromEntries(req.url.searchParams), req.body])).toEqual([
      ["GET", "/v2/actors/actor-123/versions", {}, ""],
      ["GET", "/v2/actors/actor-123/versions/0.1", {}, ""],
      ["GET", "/v2/actors/actor-123/builds", { offset: "1000", limit: "1000", desc: "true" }, ""],
      ["GET", "/v2/actor-builds/build-123", { waitForFinish: "60" }, ""],
    ]);
    const input = { startUrls: [{ url: "https://example.com?a=1&b=2" }] };
    const result = await execute("validate_actor_input", { actorId: "actor-123", build: "beta", input });
    expect(result.success).toBe(true);
    expect(requests[4].url.pathname).toBe("/v2/actors/actor-123/validate-input");
    expect(requests[4].url.searchParams.get("build")).toBe("beta");
    expect(JSON.parse(requests[4].body)).toEqual(input);
  });
  const log = "2026-10-03T10:00:00Z Build failed\nSyntaxError: unexpected token\n";
  await withApify(async (execute, requests) => {
    expect((await execute("get_log", { buildOrRunId: "build-123", raw: false })).data).toBe(log);
    expect(requests[0].url.pathname).toBe("/v2/logs/build-123");
    expect(requests[0].url.search).toBe("?raw=false");
  }, log);
});

test("Apify authoring returns provider failures without retrying billable or publishing writes", async () => {
  for (const [name, input] of [
    ["create_actor", { name: "example-actor", versions: [version] }],
    ["build_actor", { actorId: "actor-123", version: "0.1" }],
    ["update_actor", { actorId: "actor-123", isPublic: true }],
  ] as const) {
    const response = { error: { type: "rate-limit-exceeded", message: "Retry later" } };
    await withApify(async (execute, requests) => {
      const result = await execute(name, input);
      expect(result.success).toBe(false);
      expect(result.data).toEqual(response);
      expect(requests).toHaveLength(1);
    }, response, 429);
  }
});

test("Apify existing actor execution still authenticates and separates JSON input from run options", async () => {
  await withApify(async (execute, requests) => {
    const input = { startUrls: [{ url: "https://example.com" }], maxResults: 3 };
    const result = await execute("run_actor", { actorId: "apify~web-scraper", input, waitForFinish: 10, maxTotalChargeUsd: 1 });
    expect(result.success).toBe(true);
    expect(requests[0].url.pathname).toBe("/v2/actors/apify~web-scraper/runs");
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({ waitForFinish: "10", maxTotalChargeUsd: "1" });
    expect(JSON.parse(requests[0].body)).toEqual(input);
  });
});

test("Apify authoring is registered and synced to the server embedded catalog", async () => {
  expect(getAppTemplate("apify")?.tools.some(tool => tool.name === "create_actor")).toBe(true);
  const source = await Bun.file(new URL("../src/apps/apify.json", import.meta.url)).text();
  const embedded = await Bun.file(new URL("../../server/integrations-catalog/apify.json", import.meta.url)).text();
  expect(embedded).toBe(source);
  expect(new Set(apify.tools.map(tool => tool.name)).size).toBe(apify.tools.length);
  expect(source).not.toContain('"$ref"');
  expect(source).not.toContain('"x-internal"');
  expect(source).not.toContain('"forceContainsSignificantPriceChange"');
  const generated = generateMcpServer({ id: "test", credentials: { fields: { apiToken: "test-apify-token" } } } as Connection, apify as AppTemplate);
  const update = generated.tools.find(tool => tool.name === "apify_update_actor");
  expect(update?.http_config?.headers.Authorization).toBe("Bearer test-apify-token");
  expect(update?.input_schema).toEqual(apify.tools.find(tool => tool.name === "update_actor")?.input_schema);
  expect(generated.tools.find(tool => tool.name === "apify_build_actor")?.http_config?.query_params).toEqual(["version", "useCache", "betaPackages", "tag", "waitForFinish"]);
});
