import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

function toolMap(slug: string) {
  const app = getAppTemplate(slug);
  if (!app) throw new Error(`Missing ${slug} integration catalog`);
  return { app, tools: new Map(app.tools.map((tool) => [tool.name, tool])) };
}

describe("X Ads integration contract", () => {
  test("uses OAuth 1.0a and native v12 endpoints", () => {
    const { app, tools } = toolMap("twitter-ads");

    expect(app.base_url).toBe("https://ads-api.x.com/12");
    expect(app.auth.types).toEqual(["oauth1"]);
    expect(app.auth.oauth1).toMatchObject({
      request_token_url: "https://api.x.com/oauth/request_token",
      authorize_url: "https://api.x.com/oauth/authorize",
      access_token_url: "https://api.x.com/oauth/access_token",
    });
    expect(app.auth.signers).toEqual([{ name: "oauth1" }]);
    expect(tools.get("list_campaigns")?.path).toBe("/accounts/{account_id}/campaigns");
    expect(tools.get("create_line_item")?.path).toBe("/accounts/{account_id}/line_items");
    expect(tools.get("create_promoted_tweet")?.path).toBe("/accounts/{account_id}/promoted_tweets");
    expect(tools.get("get_stats")?.path).toBe("/stats/accounts/{account_id}");
    expect(tools.get("get_custom_audience")?.path).toBe("/accounts/{account_id}/custom_audiences/{custom_audience_id}");
    expect(tools.get("add_custom_audience_users")?.body_root_param).toBe("users");
    expect(tools.get("remove_custom_audience_users")?.body_root_param).toBe("users");
    expect(tools.get("get_custom_audience_usage")?.path).toBe("/accounts/{account_id}/custom_audiences/{custom_audience_id}/targeted");
    expect(tools.has("update_promoted_tweet")).toBe(false);
    expect(app.tools.some((tool) => tool.path.startsWith("/list-") || tool.path.startsWith("/get-"))).toBe(false);
  });
});

describe("Reddit Ads integration contract", () => {
  test("discovers accounts through businesses and uses current entity routes", () => {
    const { app, tools } = toolMap("reddit-ads");

    expect(app.base_url).toBe("https://ads-api.reddit.com/api/v3");
    expect(tools.get("list_my_businesses")?.path).toBe("/me/businesses");
    expect(tools.get("list_ad_accounts_by_business")?.path).toBe("/businesses/{business_id}/ad_accounts");
    expect(tools.get("query_ad_accounts")?.path).toBe("/businesses/{business_id}/ad_accounts/query");
    expect(tools.get("update_campaign")?.path).toBe("/campaigns/{campaign_id}");
    expect(tools.get("update_ad_group")?.path).toBe("/ad_groups/{ad_group_id}");
    expect(tools.get("update_ad")?.path).toBe("/ads/{ad_id}");
    expect(tools.get("create_structured_post_job")?.path).toBe("/profiles/{profile_id}/structured_posts/jobs");
    expect(tools.get("list_geolocations")?.path).toBe("/targeting/geolocations");
    expect(tools.get("list_communities")?.path).toBe("/targeting/communities");
    expect(tools.get("list_languages")?.path).toBe("/targeting/languages");
    expect(tools.get("list_saved_audiences")?.path).toBe("/ad_accounts/{ad_account_id}/saved_audiences");
    expect(tools.get("delete_saved_audience")?.path).toBe("/saved_audiences/{saved_audience_id}");
    expect(tools.get("get_report")?.continuation_url_param).toBe("next_url");
    expect(tools.has("delete_campaign")).toBe(false);
    expect(tools.has("delete_ad_group")).toBe(false);
    expect(tools.has("delete_ad")).toBe(false);
  });
});
