import { afterEach, describe, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAppCache();
});

function app(slug: string) {
  const value = getAppTemplate(slug);
  if (!value) throw new Error(`Missing ${slug} integration catalog`);
  return value;
}

function tool(slug: string, name: string) {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug}.${name}`);
  return value;
}

describe("email-verification provider catalogs", () => {
  test("exposes the synchronous tools used by Email Checker", () => {
    const expected: Record<string, string> = {
      zerobounce: "validate",
      bouncer: "verify",
      neverbounce: "single_check",
      kickbox: "verify",
      millionverifier: "verify",
      hunter: "email_verifier",
    };
    for (const [slug, toolName] of Object.entries(expected)) {
      expect(tool(slug, toolName)).toBeDefined();
      expect(app(slug).categories).toContain("email");
    }
  });

  test("builds an authenticated Bouncer real-time request", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      captured = { url: String(input), init };
      return Response.json({
        email: "person@example.com",
        status: "deliverable",
        reason: "accepted_email",
        score: 100,
      });
    }) as typeof fetch;

    await executeTool({
      app: app("bouncer"),
      tool: tool("bouncer", "verify"),
      credentials: { fields: { api_key: "bouncer-secret" } },
      input: { email: "person@example.com", timeout: 10 },
    });

    const url = new URL(captured?.url || "");
    expect(url.pathname).toBe("/v1.1/email/verify");
    expect(url.searchParams.get("email")).toBe("person@example.com");
    expect(url.searchParams.get("timeout")).toBe("10");
    expect(new Headers(captured?.init?.headers).get("x-api-key")).toBe("bouncer-secret");
  });

  test("uses the current NeverBounce and ZeroBounce request contracts", () => {
    expect(app("neverbounce").base_url).toBe("https://api.neverbounce.com/v4.2");
    expect(tool("zerobounce", "validate").input_schema.properties).toHaveProperty("timeout");
    expect(tool("zerobounce", "validate").input_schema.properties).toHaveProperty("verify_plus");
  });
});
