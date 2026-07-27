import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function appStoreConnect(): AppTemplate {
  const app = getAppTemplate("app-store-connect");
  if (!app) throw new Error("Missing App Store Connect integration catalog");
  return app;
}

function tool(name: string): AppToolTemplate {
  const found = appStoreConnect().tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing App Store Connect tool: ${name}`);
  return found;
}

describe("App Store Connect TestFlight audience catalog", () => {
  test("supports idempotent tester lookup, creation, and group assignment", () => {
    expect(tool("list_beta_testers")).toMatchObject({
      method: "GET",
      path: "/betaTesters",
    });
    expect(tool("create_beta_tester")).toMatchObject({
      method: "POST",
      path: "/betaTesters",
      request_transform: {
        type: "json_api",
        resource_type: "betaTesters",
      },
    });
    expect(tool("add_beta_testers_to_beta_group")).toMatchObject({
      method: "POST",
      path: "/betaGroups/{group_id}/relationships/betaTesters",
      body_root_param: "body",
    });
    expect(tool("add_beta_testers_to_beta_group").input_schema.required).toEqual([
      "group_id",
      "body",
    ]);
  });
});
