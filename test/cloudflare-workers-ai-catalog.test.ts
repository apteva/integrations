import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";

describe("Cloudflare Workers AI managed-provider catalog", () => {
  resetAppCache();

  test("uses the OpenAI-compatible endpoint and stays identical to the server mirror", () => {
    const app = getAppTemplate("cloudflare-workers-ai");
    if (!app) throw new Error("Missing Cloudflare Workers AI catalog");

    expect(app.base_url).toBe("https://api.cloudflare.com/client/v4/accounts/{{account_id}}/ai/v1");
    expect(app.auth.headers.Authorization).toBe("Bearer {{token}}");
    expect(app.runtime).toMatchObject({ role: "llm", provider_key: "managed", env: {} });
    expect(app.tools.find(({ name }) => name === "chat_completion")).toMatchObject({
      method: "POST",
      path: "/chat/completions",
    });

    const source = readFileSync(new URL("../src/apps/cloudflare-workers-ai.json", import.meta.url));
    const mirror = readFileSync(new URL("../../server/integrations-catalog/cloudflare-workers-ai.json", import.meta.url));
    expect(mirror.equals(source)).toBe(true);
  });
});
