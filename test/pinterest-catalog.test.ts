import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

const pinterest = getAppTemplate("pinterest") as AppTemplate;
const originalFetch = globalThis.fetch;

function tool(name: string): AppToolTemplate {
  const found = pinterest.tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Pinterest tool: ${name}`);
  return found;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Pinterest organic catalog", () => {
  test("declares a complete OAuth flow and the scopes used by its tools", () => {
    expect(pinterest.auth.oauth2).toMatchObject({
      authorize_url: "https://www.pinterest.com/oauth/",
      token_url: "https://api.pinterest.com/v5/oauth/token",
      client_id_required: true,
      pkce: false,
      token_auth_basic_only: true,
    });
    expect(pinterest.auth.oauth2?.scopes).toEqual(expect.arrayContaining([
      "user_accounts:read",
      "boards:read",
      "boards:write",
      "pins:read",
      "pins:write",
    ]));
    expect(pinterest.health_check).toEqual({ tool: "get_user_account", input: {} });
  });

  test("exposes the organic lifecycle used by Social", () => {
    for (const name of [
      "list_boards", "list_board_sections", "list_board_pins",
      "create_pin", "update_pin", "delete_pin",
      "register_media_upload", "get_media_upload",
      "get_user_account", "get_user_analytics", "get_pin_analytics",
    ]) {
      expect(tool(name)).toBeDefined();
    }
  });

  test("sends board selection as a query and the nested Pin payload as JSON", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ id: "pin-123" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: pinterest,
      tool: tool("create_pin"),
      credentials: { access_token: "pinterest-token" },
      input: {
        ad_account_id: "ad-123",
        board_id: "board-123",
        title: "A title",
        description: "A full description",
        media_source: { source_type: "image_url", url: "https://media.example/image.jpg" },
      },
    });

    expect(captured?.url).toBe("https://api.pinterest.com/v5/pins?ad_account_id=ad-123");
    expect(captured?.init.method).toBe("POST");
    expect(new Headers(captured?.init.headers).get("Authorization")).toBe("Bearer pinterest-token");
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      board_id: "board-123",
      title: "A title",
      description: "A full description",
      media_source: { source_type: "image_url", url: "https://media.example/image.jpg" },
    });
  });

  test("keeps update and analytics parameters out of the wrong transport", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ id: "pin-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await executeTool({
      app: pinterest,
      tool: tool("update_pin"),
      credentials: { access_token: "token" },
      input: { pin_id: "pin-123", ad_account_id: "ad-123", description: "Updated" },
    });
    await executeTool({
      app: pinterest,
      tool: tool("get_pin_analytics"),
      credentials: { access_token: "token" },
      input: {
        pin_id: "pin-123",
        start_date: "2026-08-01",
        end_date: "2026-08-31",
        metric_types: ["IMPRESSION", "SAVE"],
      },
    });

    expect(requests[0]?.url).toBe("https://api.pinterest.com/v5/pins/pin-123?ad_account_id=ad-123");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ description: "Updated" });
    expect(requests[1]?.url).toContain("/pins/pin-123/analytics?");
    expect(requests[1]?.url).toContain("start_date=2026-08-01");
    expect(requests[1]?.url).toContain("metric_types=IMPRESSION");
    expect(requests[1]?.url).toContain("metric_types=SAVE");
    expect(requests[1]?.init.body).toBeUndefined();
  });
});
