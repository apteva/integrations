import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Plivo integration catalog", () => {
  test("covers live call control, conferences, endpoints, MPC participants, and recording", () => {
    const app = getAppTemplate("plivo")!;
    const names = new Set(app.tools.map((tool) => tool.name));
    for (const name of [
      "start_call_recording",
      "play_audio_on_call",
      "send_call_dtmf",
      "update_conference_member",
      "start_conference_recording",
      "create_endpoint",
      "add_multiparty_participant",
      "update_multiparty_participant",
      "pause_multiparty_recording",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("has no duplicate method/path operations", () => {
    const app = getAppTemplate("plivo")!;
    const routes = app.tools.map((tool) => `${tool.method} ${tool.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
