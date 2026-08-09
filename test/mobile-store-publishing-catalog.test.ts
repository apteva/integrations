import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

function named(app: string, name: string) {
  const found = getAppTemplate(app)?.tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing ${app}.${name}`);
  return found;
}

describe("mobile store publishing catalogs", () => {
  test("App Store Connect exposes listing preparation primitives", () => {
    for (const tool of [
      "list_screenshot_sets",
      "create_screenshot_set",
      "reserve_screenshot",
      "commit_screenshot",
      "reserve_preview",
      "commit_preview",
      "get_version_review_detail",
      "create_version_review_detail",
      "reserve_review_attachment",
      "commit_review_attachment",
      "list_app_infos",
      "update_app_info_categories",
      "get_app_age_rating_declaration",
      "update_age_rating_declaration",
      "list_territories",
      "list_app_price_points",
      "list_app_schedule_manual_prices",
      "create_app_price_schedule",
      "list_app_availability_territories",
      "create_app_availability",
    ]) {
      expect(named("app-store-connect", tool)).toBeDefined();
    }
    expect(named("app-store-connect", "update_age_rating_declaration")).toMatchObject({
      body_root_param: "body",
    });
    expect(named("app-store-connect", "get_app_age_rating_declaration")).toMatchObject({
      path: "/appInfos/{app_info_id}/ageRatingDeclaration",
    });
    expect(named("app-store-connect", "list_screenshots").query_params).not.toContain("limit");
    expect(named("app-store-connect", "list_screenshot_sets").query_params).not.toContain("limit");
    expect(named("app-store-connect", "list_screenshot_sets").query_param_aliases).toMatchObject({
      display_type: "filter[screenshotDisplayType]",
    });
  });

  test("Google Play exposes deterministic image replacement and Data Safety", () => {
    expect(named("google-play-developer", "delete_all_listing_images")).toMatchObject({
      method: "DELETE",
    });
    expect(named("google-play-developer", "update_data_safety")).toMatchObject({
      method: "POST",
      path: "/applications/{packageName}/dataSafety",
    });
  });
});
