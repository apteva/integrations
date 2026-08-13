import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

function requireApp(slug: string) {
  const app = getAppTemplate(slug);
  if (!app) throw new Error(`Missing ${slug} integration catalog`);
  return app;
}

function requireTool(slug: string, name: string) {
  const app = requireApp(slug);
  const tool = app.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${slug}.${name}`);
  return tool;
}

describe("search and keyword insight integrations", () => {
  test("Google Ads exposes native Keyword Planner routes", () => {
    const ideas = requireTool("google-ads", "generate_keyword_ideas");
    expect(ideas).toMatchObject({
      method: "POST",
      path: "/customers/{customer_id}:generateKeywordIdeas",
    });
    expect(ideas.input_schema).toMatchObject({
      required: ["customer_id"],
      properties: {
        keywordSeed: { type: "object" },
        urlSeed: { type: "object" },
        keywordAndUrlSeed: { type: "object" },
        siteSeed: { type: "object" },
        geoTargetConstants: { type: "array", maxItems: 10 },
      },
    });

    const historical = requireTool(
      "google-ads",
      "generate_keyword_historical_metrics",
    );
    expect(historical).toMatchObject({
      method: "POST",
      path: "/customers/{customer_id}:generateKeywordHistoricalMetrics",
    });
    expect(historical.input_schema).toMatchObject({
      required: ["customer_id", "keywords"],
      properties: {
        keywords: { type: "array", maxItems: 10000 },
        historicalMetricsOptions: { type: "object" },
      },
    });
  });

  test("Search Console uses renewable Google OAuth and exposes full analytics controls", () => {
    const app = requireApp("google-search-console");
    expect(app.auth.oauth2).toMatchObject({
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/webmasters"],
      extra_authorize_params: {
        access_type: "offline",
      },
    });

    const fields = new Map(
      (app.auth.credential_fields || []).map((field) => [field.name, field]),
    );
    expect(fields.get("token")).toMatchObject({ source: "oauth", hidden: true });
    expect(fields.get("refresh_token")).toMatchObject({
      source: "oauth",
      hidden: true,
    });

    const query = requireTool("google-search-console", "query_search_analytics");
    expect(query.input_schema).toMatchObject({
      properties: {
        aggregationType: { type: "string" },
        dataState: { type: "string" },
        rowLimit: { type: "integer", maximum: 25000 },
        dimensionFilterGroups: { type: "array" },
      },
    });
  });

  test("Microsoft Advertising uses the Ad Insight REST host", () => {
    const expected = new Map([
      ["get_historical_search_count", "/AdInsight/v13/HistoricalSearchCount/Query"],
      ["get_keyword_ideas", "/AdInsight/v13/KeywordIdeas/Query"],
      [
        "get_keyword_traffic_estimates",
        "/AdInsight/v13/KeywordTrafficEstimates/Query",
      ],
    ]);

    for (const [name, path] of expected) {
      expect(requireTool("microsoft-ads", name)).toMatchObject({
        method: "POST",
        base_url: "https://adinsight.api.bingads.microsoft.com",
        path,
      });
    }

    expect(
      requireTool("microsoft-ads", "get_historical_search_count").input_schema,
    ).toMatchObject({
      required: ["Keywords", "Language", "StartDate", "EndDate", "TimePeriodRollup"],
      properties: {
        Keywords: { type: "array", maxItems: 1000 },
        Devices: { type: "array" },
      },
    });

    expect(requireTool("microsoft-ads", "get_keyword_ideas").input_schema).toMatchObject({
      properties: {
        SearchParameters: {
          items: {
            required: ["Type"],
            properties: {
              Type: { type: "string" },
              Queries: { type: "array", maxItems: 200 },
              Languages: { type: "array" },
              Locations: { type: "array", maxItems: 2000 },
            },
          },
        },
      },
    });
  });

  test("YouTube analytics documents owned-channel search-term queries", () => {
    const app = requireApp("youtube-api");
    expect(app.auth.oauth2?.scopes).toContain(
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    );

    const analytics = requireTool("youtube-api", "query_analytics_report");
    expect(analytics).toMatchObject({
      method: "GET",
      path: "https://youtubeanalytics.googleapis.com/v2/reports",
    });
    expect(analytics.description).toContain("insightTrafficSourceType==YT_SEARCH");
    expect(analytics.description).toContain("not public YouTube keyword volume");
  });
});
