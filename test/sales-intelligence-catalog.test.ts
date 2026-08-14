import { afterEach, describe, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import { getAppTemplate, resetAppCache } from "../src/apps/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAppCache();
});

function app(slug: string) {
  const value = getAppTemplate(slug);
  if (!value) throw new Error(`Missing ${slug} integration catalog`);
  return value;
}

function tool(slug: string, name: string) {
  const value = app(slug).tools.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing ${slug}.${name}`);
  return value;
}

describe("sales-intelligence catalog coverage", () => {
  test("provides the supported first-class vendor APIs without duplicate tool names", () => {
    const expected: Record<string, string[]> = {
      apollo: [
        "people_search",
        "people_enrich",
        "list_organization_job_postings",
        "sequence_add_contacts",
        "create_task",
        "create_email_draft",
        "view_credit_usage",
      ],
      uplead: [
        "lookup_person",
        "lookup_company",
        "prospect_contacts",
        "quick_search",
        "list_saved_lists",
        "add_contacts_to_list",
      ],
      cognism: [
        "search_contacts",
        "redeem_contacts",
        "enrich_contact",
        "get_contact_entitlements",
        "check_opt_out_by_email",
      ],
      zoominfo: [
        "search_contacts",
        "enrich_contact",
        "search_companies",
        "enrich_company",
        "search_intent",
      ],
      clay: [
        "create_structured_search",
        "run_structured_search",
        "run_routine",
        "get_routine_results",
        "query_tables",
      ],
    };

    for (const [slug, names] of Object.entries(expected)) {
      const integration = app(slug);
      const actual = integration.tools.map((candidate) => candidate.name);
      expect(new Set(actual).size).toBe(actual.length);
      for (const name of names) expect(actual).toContain(name);
    }
  });

  test("uses a valid read-only health check where the provider exposes one", () => {
    for (const slug of ["apollo", "uplead", "cognism", "clay"]) {
      const integration = app(slug);
      expect(integration.health_check?.tool).toBeTruthy();
      expect(
        integration.tools.some(
          (candidate) => candidate.name === integration.health_check?.tool,
        ),
      ).toBe(true);
    }
  });

  test("does not mislabel generic LinkedIn as a Sales Navigator API", () => {
    expect(getAppTemplate("linkedin-sales-navigator")).toBeUndefined();
    expect(app("linkedin").name).toBe("LinkedIn");
  });
});

describe("sales-intelligence request contracts", () => {
  test("sends Apollo sequence enrollment using the documented query keys", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body || "");
      return Response.json({ contacts: [] });
    }) as typeof fetch;

    const integration = app("apollo");
    await executeTool({
      app: integration,
      tool: tool("apollo", "sequence_add_contacts"),
      credentials: { fields: { api_key: "secret" } },
      input: {
        sequence_id: "seq-1",
        emailer_campaign_id: "seq-1",
        contact_ids: ["contact-1", "contact-2"],
      },
    });

    const parsed = new URL(requestUrl);
    expect(parsed.pathname).toBe(
      "/api/v1/emailer_campaigns/seq-1/add_contact_ids",
    );
    expect(parsed.searchParams.get("emailer_campaign_id")).toBe("seq-1");
    expect(parsed.searchParams.getAll("contact_ids[]")).toEqual([
      "contact-1",
      "contact-2",
    ]);
    expect(JSON.parse(requestBody)).toEqual({});
  });

  test("sends UpLead prospect filters as JSON", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body || "");
      return Response.json({ data: { results: [] } });
    }) as typeof fetch;

    const integration = app("uplead");
    await executeTool({
      app: integration,
      tool: tool("uplead", "prospect_contacts"),
      credentials: { fields: { api_key: "secret" } },
      input: {
        job_functions: ["sales"],
        management_levels: ["VP"],
        count_only: true,
      },
    });

    expect(requestUrl).toBe("https://api.uplead.com/v2/prospector-pro-search");
    expect(JSON.parse(requestBody)).toEqual({
      job_functions: ["sales"],
      management_levels: ["VP"],
      count_only: true,
    });
  });

  test("splits Cognism cursor pagination from the search body", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body || "");
      return Response.json({ results: [] });
    }) as typeof fetch;

    const integration = app("cognism");
    await executeTool({
      app: integration,
      tool: tool("cognism", "search_contacts"),
      credentials: { fields: { token: "secret" } },
      input: {
        indexSize: 50,
        lastReturnedKey: "next-key",
        jobTitles: ["VP Sales"],
        regions: ["EMEA"],
      },
    });

    expect(requestUrl).toBe(
      "https://app.cognism.com/api/search/contact/search?indexSize=50&lastReturnedKey=next-key",
    );
    expect(JSON.parse(requestBody)).toEqual({
      jobTitles: ["VP Sales"],
      regions: ["EMEA"],
    });
  });

  test("uses Clay's documented API-key header", async () => {
    let requestHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return Response.json({ id: "user-1" });
    }) as typeof fetch;

    const integration = app("clay");
    await executeTool({
      app: integration,
      tool: tool("clay", "get_current_user"),
      credentials: { fields: { api_key: "clay-secret" } },
      input: {},
    });

    expect(requestHeaders?.get("clay-api-key")).toBe("clay-secret");
  });

  test("exchanges ZoomInfo credentials for a short-lived JWT", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/authenticate")) {
        return Response.json({ jwt: "zoom-jwt" });
      }
      return Response.json({ data: [] });
    }) as typeof fetch;

    const integration = app("zoominfo");
    await executeTool({
      app: integration,
      tool: tool("zoominfo", "search_companies"),
      credentials: { fields: { username: "api-user", password: "password" } },
      input: { companyWebsite: "example.com" },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.zoominfo.com/authenticate");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      username: "api-user",
      password: "password",
    });
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe(
      "Bearer zoom-jwt",
    );
  });
});
