import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const app = getAppTemplate("admob")!;
const accountID = "pub-9876543210987654";
const execute = (name: string, input: Record<string, unknown>) => executeTool({
  app,
  tool: app.tools.find((tool) => tool.name === name)!,
  credentials: { access_token: "admob-test-token" },
  input,
});

describe("AdMob publisher analytics", () => {
  test("requests renewable read-only Google OAuth for inventory and reports", () => {
    expect(app.auth.oauth2).toMatchObject({
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/admob.readonly"],
      client_id_required: true,
      extra_authorize_params: { access_type: "offline", prompt: "consent select_account" },
    });
    for (const field of app.auth.credential_fields ?? []) {
      expect(field).toMatchObject({ source: "oauth", hidden: true, required: false });
    }
    expect(app.health_check).toEqual({ tool: "list_accounts", input: { pageSize: 1 } });
  });

  test.each([
    ["list_accounts", "/accounts", "account"],
    ["list_apps", `/accounts/${accountID}/apps`, "apps"],
    ["list_ad_units", `/accounts/${accountID}/adUnits`, "adUnits"],
  ])("%s preserves pagination and sends no request body", async (name, path, collection) => {
    let capturedURL: URL | undefined;
    let capturedInit: RequestInit | undefined;
    const response = { [collection]: [{ name: "fixture" }], nextPageToken: "next-page" };
    globalThis.fetch = async (url, init) => {
      capturedURL = new URL(String(url)); capturedInit = init;
      return Response.json(response);
    };
    const result = await execute(name, {
      ...(name === "list_accounts" ? {} : { account_id: accountID }),
      pageSize: 25, pageToken: "page+token/with=characters",
    });
    expect(capturedURL?.origin).toBe("https://admob.googleapis.com");
    expect(capturedURL?.pathname).toBe(`/v1${path}`);
    expect(capturedURL?.searchParams.get("pageSize")).toBe("25");
    expect(capturedURL?.searchParams.get("pageToken")).toBe("page+token/with=characters");
    expect(capturedURL?.searchParams.has("account_id")).toBe(false);
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.body).toBeUndefined();
    expect(new Headers(capturedInit?.headers).get("Authorization")).toBe("Bearer admob-test-token");
    expect(result.success).toBe(true);
    expect(result.data).toEqual(response);
  });

  test("account lookup retains the reporting currency and time zone", async () => {
    let capturedURL = "";
    const response = { name: `accounts/${accountID}`, publisherId: accountID, currencyCode: "EUR", reportingTimeZone: "Europe/Paris" };
    globalThis.fetch = async (url) => { capturedURL = String(url); return Response.json(response); };
    const result = await execute("get_account", { account_id: accountID });
    expect(capturedURL).toBe(`https://admob.googleapis.com/v1/accounts/${accountID}`);
    expect(result.data).toEqual(response);
  });

  test.each(["network", "mediation"])("%s reports post reportSpec and preserve the complete response array", async (kind) => {
    let capturedURL = "";
    let capturedInit: RequestInit | undefined;
    const reportSpec = {
      dateRange: { startDate: { year: 2026, month: 8, day: 1 }, endDate: { year: 2026, month: 8, day: 31 } },
      dimensions: kind === "network" ? ["DATE", "APP", "COUNTRY"] : ["DATE", "APP", "AD_SOURCE"],
      metrics: ["ESTIMATED_EARNINGS", kind === "network" ? "IMPRESSION_RPM" : "OBSERVED_ECPM"],
      dimensionFilters: [{ dimension: "COUNTRY", matchesAny: { values: ["US", "FR"] } }],
      sortConditions: [{ metric: "ESTIMATED_EARNINGS", order: "DESCENDING" }],
      localizationSettings: { currencyCode: "USD", languageCode: "en-US" },
      maxReportRows: 100, timeZone: "America/Los_Angeles",
    };
    const response = [
      { header: { dateRange: reportSpec.dateRange, localizationSettings: reportSpec.localizationSettings, reportingTimeZone: reportSpec.timeZone } },
      { row: { metricValues: { ESTIMATED_EARNINGS: { microsValue: "9007199254740993" } } } },
      { footer: { matchingRowCount: "150", warnings: [{ type: "DATA_DELAYED", description: "Delayed data" }] } },
    ];
    globalThis.fetch = async (url, init) => {
      capturedURL = String(url); capturedInit = init;
      return Response.json(response);
    };
    const result = await execute(`generate_${kind}_report`, { account_id: accountID, reportSpec });
    expect(capturedURL).toBe(`https://admob.googleapis.com/v1/accounts/${accountID}/${kind}Report:generate`);
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ reportSpec });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(response);
  });

  test.each([403, 429])("HTTP %i report failures remain failures", async (status) => {
    globalThis.fetch = async () => Response.json({ error: { code: status, message: "Provider error" } }, { status });
    const result = await execute("generate_network_report", {
      account_id: accountID,
      reportSpec: { dateRange: { startDate: { year: 2026, month: 8, day: 1 }, endDate: { year: 2026, month: 8, day: 2 } }, metrics: ["IMPRESSIONS"] },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(status);
  });

  test("report schemas distinguish network metrics from mediation metrics", () => {
    const spec = (name: string) => app.tools.find((tool) => tool.name === name)!.input_schema.properties!.reportSpec as any;
    const network = spec("generate_network_report");
    const mediation = spec("generate_mediation_report");
    expect(network.required).toEqual(["dateRange", "metrics"]);
    expect(network.properties.metrics.items.enum).toContain("IMPRESSION_RPM");
    expect(network.properties.metrics.items.enum).not.toContain("OBSERVED_ECPM");
    expect(mediation.properties.metrics.items.enum).toContain("OBSERVED_ECPM");
    expect(mediation.properties.dimensions.items.enum).toContain("AD_SOURCE");
    expect(network.properties.maxReportRows.maximum).toBe(100000);
    expect(network.properties.dimensionFilters.items.properties.matchesAny.properties.values.items.type).toBe("string");
  });
});
