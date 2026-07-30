import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Twilio advanced voice catalog", () => {
  test("covers conferences, live recording/streaming, queues, SIP domains, and trunks", () => {
    const app = getAppTemplate("twilio")!;
    const names = new Set(app.tools.map((tool) => tool.name));
    for (const name of [
      "create_conference_participant",
      "update_conference_participant",
      "start_call_recording",
      "update_call_recording",
      "create_call_stream",
      "dequeue_member",
      "create_sip_domain",
      "create_elastic_sip_trunk",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});
