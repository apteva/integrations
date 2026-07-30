import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("CloudTalk integration catalog", () => {
  test("matches every route in the published OpenAPI surface", () => {
    const app = getAppTemplate("cloudtalk")!;
    const routes = new Set(app.tools.map((tool) => `${tool.method} ${tool.path}`));
    for (const route of [
      "POST /bulk/contacts.json",
      "PUT /campaigns/add.json",
      "GET /contacts/attributes.json",
      "PUT /contacts/addTags/{contactId}.json",
      "PUT /notes/add/{contactId}.json",
      "PUT /activity/add/{contactId}.json",
      "POST /numbers/edit/{id}.json",
      "DELETE /recordings/delete/{callId}.json",
      "GET /statistics/realtime/groups.json",
      "GET /ai/calls/{callId}/talk-listen-ratio",
      "POST /voice-agent/calls",
      "POST /cuecards",
    ]) {
      expect(routes.has(route)).toBe(true);
    }
  });

  test("uses the documented alternate hosts for VoiceAgent and cue-card routes", () => {
    const app = getAppTemplate("cloudtalk")!;
    expect(app.tools.find((tool) => tool.name === "create_voice_agent_call")!.base_url).toBe(
      "https://api.cloudtalk.io/v1",
    );
    expect(app.tools.find((tool) => tool.name === "create_cuecard")!.base_url).toBe(
      "https://platform-api.cloudtalk.io/api",
    );
  });
});
