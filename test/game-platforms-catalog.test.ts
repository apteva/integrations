import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const providers = [
  "playcanvas",
  "unity-build-automation",
  "roblox-open-cloud",
  "scenario",
  "lootlocker",
  "playfab",
] as const;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function app(slug: string): AppTemplate {
  const found = getAppTemplate(slug);
  if (!found) throw new Error(`Missing game-platform integration: ${slug}`);
  return found;
}

function tool(slug: string, name: string): AppToolTemplate {
  const found = app(slug).tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${slug} tool: ${name}`);
  return found;
}

describe("public game-production API catalogs", () => {
  test("registers six focused providers with explicit, unique tool contracts", () => {
    const expectedCounts: Record<(typeof providers)[number], number> = {
      playcanvas: 14,
      "unity-build-automation": 17,
      "roblox-open-cloud": 10,
      scenario: 8,
      lootlocker: 12,
      playfab: 10,
    };

    for (const slug of providers) {
      const catalog = app(slug);
      expect(catalog.tools).toHaveLength(expectedCounts[slug]);
      expect(catalog.health_check?.tool || catalog.tools[0]?.name).toBeTruthy();

      const names = catalog.tools.map(({ name }) => name);
      const routes = catalog.tools.map(({ method, path }) => `${method} ${path}`);
      expect(new Set(names).size).toBe(names.length);
      expect(new Set(routes).size).toBe(routes.length);

      for (const candidate of catalog.tools) {
        expect(candidate.description.length).toBeGreaterThan(30);
        expect(candidate.input_schema.properties?.body).toBeUndefined();

        const pathParameters = [...candidate.path.matchAll(/\{([^}]+)\}/g)].map(
          (match) => match[1],
        );
        for (const parameter of pathParameters) {
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
          expect(candidate.input_schema.required).toContain(parameter);
        }
        for (const parameter of candidate.query_params ?? []) {
          expect(candidate.input_schema.properties?.[parameter]).toBeDefined();
        }
      }
    }
  });

  test("exposes useful build, publishing, generation, and backend workflows", () => {
    expect(tool("playcanvas", "download_app")).toMatchObject({ method: "POST", path: "/apps/download" });
    expect(tool("playcanvas", "create_asset").multipart_form?.file_fields).toEqual({ file: "file" });
    expect(tool("unity-build-automation", "start_build").path).toContain("/builds");
    expect(tool("unity-build-automation", "list_xcode_versions").path).toBe("/versions/xcode");
    expect(tool("roblox-open-cloud", "publish_place_version")).toMatchObject({ body_binary_param: "file" });
    expect(tool("scenario", "run_model")).toMatchObject({ body_root_param: "parameters" });
    expect(tool("lootlocker", "submit_leaderboard_score").input_schema.required).toEqual([
      "leaderboard",
      "member_id",
      "score",
    ]);
    expect(tool("playfab", "execute_cloud_script").path).toBe("/Server/ExecuteCloudScript");
  });

  test("builds a PlayCanvas multipart asset upload", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return Response.json({ id: 41 }, { status: 201 });
    };

    const result = await executeTool({
      app: app("playcanvas"),
      tool: tool("playcanvas", "create_asset"),
      credentials: { fields: { api_key: "pc-token" } },
      input: {
        name: "game.js",
        projectId: 123,
        branchId: "branch-main",
        preload: true,
        file: `data:text/javascript;base64,${Buffer.from("console.log('ok')").toString("base64")}`,
      },
    });

    expect(result.success).toBe(true);
    expect(captured?.url).toBe("https://playcanvas.com/api/assets");
    expect(captured?.init.headers).toMatchObject({ Authorization: "Bearer pc-token" });
    const form = captured?.init.body as FormData;
    expect(form.get("name")).toBe("game.js");
    expect(form.get("projectId")).toBe("123");
    expect(form.get("branchId")).toBe("branch-main");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  test("starts a Unity build with Unity's raw Basic API-key convention", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return Response.json({ build: 9 }, { status: 202 });
    };

    await executeTool({
      app: app("unity-build-automation"),
      tool: tool("unity-build-automation", "start_build"),
      credentials: { fields: { api_key: "unity-api-key" } },
      input: {
        orgid: "org",
        projectid: "project",
        buildtargetid: "ios-release",
        clean: true,
        branch: "main",
        machineTypeLabel: "mac_standard_v1",
      },
    });

    expect(captured?.url).toBe(
      "https://build-api.cloud.unity3d.com/api/v1/orgs/org/projects/project/buildtargets/ios-release/builds",
    );
    expect(captured?.init.headers).toMatchObject({ Authorization: "Basic unity-api-key" });
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      clean: true,
      branch: "main",
      machineTypeLabel: "mac_standard_v1",
    });
  });

  test("publishes Roblox place bytes without wrapping them in JSON", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return Response.json({ versionNumber: 7 });
    };

    await executeTool({
      app: app("roblox-open-cloud"),
      tool: tool("roblox-open-cloud", "publish_place_version"),
      credentials: { fields: { api_key: "roblox-key" } },
      input: {
        universeId: "101",
        placeId: "202",
        versionType: "Published",
        file: {
          _binary: true,
          base64: Buffer.from("place-bytes").toString("base64"),
          mimeType: "application/octet-stream",
        },
      },
    });

    expect(captured?.url).toBe(
      "https://apis.roblox.com/universes/v1/101/places/202/versions?versionType=Published",
    );
    expect(captured?.init.headers).toMatchObject({
      "x-api-key": "roblox-key",
      "Content-Type": "application/octet-stream",
    });
    expect(Buffer.from(captured?.init.body as Uint8Array).toString()).toBe("place-bytes");
  });

  test("sends Scenario's model parameters as the root request body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return Response.json({ jobId: "job-1" }, { status: 202 });
    };

    await executeTool({
      app: app("scenario"),
      tool: tool("scenario", "run_model"),
      credentials: { fields: { api_key: "scenario-key", api_secret: "scenario-secret" } },
      input: {
        modelId: "model-1",
        projectId: "project-1",
        dryRun: true,
        parameters: { prompt: "painted forest", numSamples: 2 },
      },
    });

    expect(captured?.url).toBe(
      "https://api.cloud.scenario.com/v1/generate/custom/model-1?projectId=project-1&dryRun=true",
    );
    expect(captured?.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("scenario-key:scenario-secret").toString("base64")}`,
    });
    expect(JSON.parse(String(captured?.init.body))).toEqual({ prompt: "painted forest", numSamples: 2 });
  });

  test("creates a LootLocker server session before calling a backend tool", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (calls.length === 1) return Response.json({ token: "session-token" });
      return Response.json({ pong: true });
    };

    await executeTool({
      app: app("lootlocker"),
      tool: tool("lootlocker", "ping_server"),
      credentials: { fields: { server_key: "server-key", game_version: "2.4.0" } },
      input: {},
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.lootlocker.io/server/session");
    expect(calls[0]?.init.headers).toMatchObject({
      "x-server-key": "server-key",
      "LL-Version": "2021-03-01",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ game_version: "2.4.0" });
    expect(calls[1]?.url).toBe("https://api.lootlocker.io/server/ping");
    expect(calls[1]?.init.headers).toMatchObject({
      "x-auth-token": "session-token",
      "LL-Version": "2021-03-01",
    });
  });

  test("routes PlayFab server calls through the title-specific hostname", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return Response.json({ code: 200, data: {} });
    };

    await executeTool({
      app: app("playfab"),
      tool: tool("playfab", "update_player_statistics"),
      credentials: { fields: { title_id: "AB12C", secret_key: "title-secret" } },
      input: {
        PlayFabId: "player-1",
        Statistics: [{ StatisticName: "Score", Value: 9001 }],
      },
    });

    expect(captured?.url).toBe("https://AB12C.playfabapi.com/Server/UpdatePlayerStatistics");
    expect(captured?.init.headers).toMatchObject({ "X-SecretKey": "title-secret" });
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      PlayFabId: "player-1",
      Statistics: [{ StatisticName: "Score", Value: 9001 }],
    });
  });
});
