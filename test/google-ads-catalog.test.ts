import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Google Ads integration credentials", () => {
  test("separates operator inputs from OAuth-generated fields", () => {
    const app = getAppTemplate("google-ads");
    if (!app) throw new Error("Missing Google Ads integration catalog");

    const fields = app.auth.credential_fields || [];
    const byName = new Map(fields.map((field) => [field.name, field]));

    expect(byName.get("developer_token")).toMatchObject({
      source: "user",
      type: "password",
      required: true,
    });
    expect(byName.get("manager_customer_id")).toMatchObject({
      source: "user",
      type: "text",
      required: false,
    });
    for (const name of ["token", "refresh_token", "expires_in", "token_type"]) {
      expect(byName.get(name)).toMatchObject({
        source: "oauth",
        hidden: true,
        required: false,
      });
    }
  });
});
