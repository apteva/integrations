import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function integration(slug: string): AppTemplate {
  const app = getAppTemplate(slug);
  if (!app) throw new Error(`Missing integration catalog: ${slug}`);
  return app;
}

function tool(slug: string, name: string): AppToolTemplate {
  const candidate = integration(slug).tools.find((entry) => entry.name === name);
  if (!candidate) throw new Error(`Missing ${slug} tool: ${name}`);
  return candidate;
}

describe("phone number integration catalogs", () => {
  test("expose provider inventory and pricing operations", () => {
    expect(tool("twilio", "get_phone_number_pricing").method).toBe("GET");
    expect(tool("twilio", "get_voice_pricing").method).toBe("GET");
    expect(tool("telnyx", "search_available_phone_numbers").method).toBe("GET");
    expect(tool("plivo", "get_number_pricing").method).toBe("GET");
    expect(tool("signalwire", "search_available_numbers").method).toBe("GET");
    expect(tool("vonage", "numbers_search").method).toBe("GET");
  });

  test("uses classic Vonage credentials only on number endpoints", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ numbers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const credentials = {
        access_token: "voice-jwt",
        fields: { api_key: "number-key", api_secret: "number-secret" },
      };
      await executeTool({
        app: integration("vonage"),
        tool: tool("vonage", "numbers_search"),
        credentials,
        input: { country: "EE", type: "landline", size: 5 },
      });
      await executeTool({
        app: integration("vonage"),
        tool: tool("vonage", "create_voice_call"),
        credentials,
        input: {
          to: [{ type: "phone", number: "3725550100" }],
          from: { type: "phone", number: "12025550100" },
          ncco: [],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured[0]?.url).toBe(
      "https://rest.nexmo.com/number/search?api_key=number-key&api_secret=number-secret&country=EE&type=landline&size=5",
    );
    expect(captured[1]?.url).toBe("https://api.nexmo.com/v1/calls");
    expect(captured[1]?.url).not.toContain("number-secret");
    expect(captured[1]?.init.headers).toMatchObject({ Authorization: "Bearer voice-jwt" });
  });
});
