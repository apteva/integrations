import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppToolTemplate } from "../src/types.js";

function tool(name: string): AppToolTemplate {
  const app = getAppTemplate("app-store-connect");
  const found = app?.tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing App Store Connect tool: ${name}`);
  return found;
}

describe("App Store Connect bundle capability catalog", () => {
  test("lists capabilities through the bundle ID relationship", () => {
    expect(tool("list_bundle_id_capabilities")).toMatchObject({
      method: "GET",
      path: "/bundleIds/{bundle_id}/bundleIdCapabilities",
    });
    expect(tool("list_bundle_id_capabilities").input_schema.required).toContain(
      "bundle_id",
    );
  });

  test("enables capabilities with Apple's JSON:API relationship", () => {
    expect(tool("enable_bundle_id_capability")).toMatchObject({
      method: "POST",
      path: "/bundleIdCapabilities",
      request_transform: {
        type: "json_api",
        resource_type: "bundleIdCapabilities",
        attributes: ["capabilityType", "settings"],
        relationships: {
          bundleId: {
            source: "bundle_id",
            resource_type: "bundleIds",
          },
        },
      },
    });
  });

  test("supports explicit capability updates and disables", () => {
    expect(tool("update_bundle_id_capability")).toMatchObject({
      method: "PATCH",
      path: "/bundleIdCapabilities/{capability_id}",
      request_transform: {
        type: "json_api",
        resource_type: "bundleIdCapabilities",
        id_field: "capability_id",
      },
    });
    expect(tool("disable_bundle_id_capability")).toMatchObject({
      method: "DELETE",
      path: "/bundleIdCapabilities/{capability_id}",
    });
  });
});
