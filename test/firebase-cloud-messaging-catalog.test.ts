import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Firebase Cloud Messaging integration", () => {
  test("uses the HTTP v1 endpoint with service-account signing", () => {
    const app = getAppTemplate("firebase-cloud-messaging");
    expect(app).toBeDefined();
    expect(app?.base_url).toBe("https://fcm.googleapis.com");
    expect(app?.auth.signers).toEqual([{ name: "google_service_account" }]);
    expect(
      app?.auth.credential_fields?.find(
        (field) => field.name === "service_account_json",
      ),
    ).toMatchObject({ type: "multiline_password" });
    expect(
      app?.auth.credential_fields?.find(
        (field) => field.name === "relay_encryption_key",
      ),
    ).toMatchObject({
      source: "generated",
      hidden: true,
      required: false,
    });

    const send = app?.tools.find((tool) => tool.name === "send_message");
    expect(send).toMatchObject({
      method: "POST",
      path: "/v1/projects/-/messages:send",
    });
    expect(send?.input_schema.required).toEqual(["message"]);
    expect(send?.input_schema.properties?.validate_only).toMatchObject({
      type: "boolean",
    });
  });
});
