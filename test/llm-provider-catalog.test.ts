import { describe, expect, test } from "bun:test";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";

const expected = [
  {
    slug: "minimax-api",
    baseURL: "https://api.minimax.io/v1",
    tools: ["chat_completion", "list_models", "get_model"],
    healthTool: "list_models",
  },
  {
    slug: "z-ai",
    baseURL: "https://api.z.ai/api/paas/v4",
    tools: ["chat_completion", "count_tokens"],
    healthTool: undefined,
  },
  {
    slug: "moonshot-ai",
    baseURL: "https://api.moonshot.ai/v1",
    tools: ["chat_completion", "list_models"],
    healthTool: "list_models",
  },
] as const;

describe("LLM provider integration catalogs", () => {
  resetAppCache();

  for (const provider of expected) {
    test(`${provider.slug} exposes a bindable OpenAI-compatible chat route`, () => {
      const app = getAppTemplate(provider.slug);
      if (!app) throw new Error(`Missing ${provider.slug} integration catalog`);

      expect(app.base_url).toBe(provider.baseURL);
      expect(app.auth.types).toEqual(["bearer"]);
      expect(app.auth.headers.Authorization).toBe("Bearer {{api_key}}");
      expect(app.auth.credential_fields?.map(({ name }) => name)).toEqual(["api_key"]);
      expect(app.tools.map(({ name }) => name)).toEqual(provider.tools);
      expect(new Set(app.tools.map(({ name }) => name)).size).toBe(app.tools.length);
      expect(app.health_check?.tool).toBe(provider.healthTool);

      const chat = app.tools.find(({ name }) => name === "chat_completion");
      expect(chat).toMatchObject({
        method: "POST",
        path: "/chat/completions",
      });
      expect(chat?.input_schema.required).toEqual(["model", "messages"]);
      expect(chat?.input_schema.properties?.messages).toMatchObject({
        type: "array",
        minItems: 1,
      });
      expect(chat?.input_schema.properties?.stream).toMatchObject({
        type: "boolean",
        default: false,
      });

      for (const tool of app.tools) {
        expect(tool.path.startsWith("/")).toBe(true);
        expect(tool.input_schema.type).toBe("object");
        expect(tool.input_schema.properties?.body).toBeUndefined();
      }
    });
  }

  test("only providers with documented model-list APIs use list_models for health", () => {
    expect(getAppTemplate("minimax-api")?.health_check).toEqual({ tool: "list_models" });
    expect(getAppTemplate("moonshot-ai")?.health_check).toEqual({ tool: "list_models" });
    expect(getAppTemplate("z-ai")?.tools.some(({ name }) => name === "list_models")).toBe(false);
    expect(getAppTemplate("z-ai")?.tools.find(({ name }) => name === "count_tokens")).toMatchObject({
      method: "POST",
      path: "/tokenizer",
    });
  });
});

test("Gemini restricts agent reasoning separately from integration media tools", () => {
  const app = getAppTemplate("gemini")!;
  const policy = app.runtime!.model_policy!;
  expect(policy.purpose).toBe("agent");
  expect(policy.required_methods).toEqual(["generateContent"]);
  const eligible = (id: string) => policy.allowed_id_patterns.some(pattern => new RegExp(pattern).test(id));
  for (const id of ["gemini-2.5-pro", "gemini-3.7-flash", "gemini-2.5-flash-lite", "gemini-3.1-pro-preview"]) expect(eligible(id)).toBe(true);
  for (const id of ["antigravity-preview-05-2026", "gemini-2.5-flash-image", "gemini-2.5-flash-preview-tts", "gemini-embedding-001", "gemini-3.1-flash-live-preview"]) expect(eligible(id)).toBe(false);
  expect(Object.keys(policy.tier_preferences).sort()).toEqual(["large", "medium", "small"]);
  for (const tool of ["generate_content", "generate_image", "edit_image", "start_video_generation", "create_embedding", "list_models"]) expect(app.tools.some(t => t.name === tool)).toBe(true);
  for (const slug of ["minimax-api", "z-ai", "moonshot-ai"]) expect(getAppTemplate(slug)!.runtime?.model_policy).toBeUndefined();
});
