import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Telnyx integration catalog", () => {
  test("requires only the Telnyx API key to connect", () => {
    const app = getAppTemplate("telnyx")!;
    const requiredCredentials = app.auth.credential_fields
      ?.filter((field) => field.required)
      .map((field) => field.name);

    expect(requiredCredentials).toEqual(["token"]);
    expect(app.auth.headers.Authorization).toBe("Bearer {{token}}");
  });

  test("exposes each HTTP operation once", () => {
    const app = getAppTemplate("telnyx")!;
    const routes = app.tools.map((tool) => `${tool.method} ${tool.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    expect(app.tools.some((tool) => tool.name === "dial_call")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "hangup_call")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "list_outbound_voice_profiles")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "create_outbound_voice_profile")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "update_outbound_voice_profile")).toBe(true);
    expect(app.tools.some((tool) => tool.name === "make_call")).toBe(false);
    expect(app.tools.some((tool) => tool.name === "update_call")).toBe(false);
  });

  test("declares every Telnyx media option used by Telephony", () => {
    const app = getAppTemplate("telnyx")!;
    const dial = app.tools.find((tool) => tool.name === "dial_call")!;
    const properties = dial.input_schema.properties ?? {};

    expect(properties.stream_bidirectional_sampling_rate).toBeDefined();
    expect(properties.stream_establish_before_call_originate).toBeDefined();
    expect(properties.send_silence_when_idle).toBeDefined();
  });
});
