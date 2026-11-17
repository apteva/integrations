import { expect, test } from "bun:test";
import dynadot from "../src/apps/dynadot.json";
import { executeTool } from "../src/http-executor";
import type { AppTemplate, AppToolTemplate } from "../src/types";

type Captured = { url: URL; method: string; headers: Headers; body: string };

async function withDynadot(
  response: unknown,
  run: (execute: (name: string, input: Record<string, unknown>) => ReturnType<typeof executeTool>, requests: Captured[]) => Promise<void>,
) {
  const requests: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({ url: new URL(req.url), method: req.method, headers: req.headers, body: await req.text() });
      return Response.json(response);
    },
  });
  try {
    await run((name, input) => executeTool({
      app: { ...dynadot, base_url: `http://127.0.0.1:${server.port}` } as AppTemplate,
      tool: dynadot.tools.find(tool => tool.name === name) as AppToolTemplate,
      credentials: { fields: { api_key: "test-key&with=reserved+characters" } },
      input,
    }), requests);
  } finally {
    server.stop(true);
  }
}

test("Dynadot sends fixed-price and offer listings to API3 with query authentication", async () => {
  const response = { SetForSaleResponse: { ResponseCode: "0", Status: "Success" } };
  await withDynadot(response, async (execute, requests) => {
    const inputs = [
      { domain: "example.com", listing_type: "buy_now", price: "1000.00" },
      { domain: "example.net", listing_type: "make_offer", minimum_offer: "250.00" },
      {
        domain: "example.org", listing_type: "buy_now_and_make_offer", price: "2000.00",
        minimum_offer: "1200.00", installment: "Yes", maximum_installments: 4,
        category: "health", sub_category: "fitness", description: "Health & fitness + coaching",
      },
    ];
    for (const input of inputs) {
      const result = await execute("set_for_sale", input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(response);
    }
    requests.forEach((req, i) => {
      const { domain, ...sale } = inputs[i];
      expect(req.method).toBe("GET");
      expect(req.url.pathname).toBe("/api3.json");
      expect(Object.fromEntries(req.url.searchParams)).toEqual({
        command: "set_for_sale", for_sale_type: "marketplace",
        key: "test-key&with=reserved+characters", domains: domain,
        ...Object.fromEntries(Object.entries(sale).map(([key, value]) => [key, String(value)])),
      });
      expect(req.headers.has("Authorization")).toBe(false);
      expect(req.body).toBe("");
    });
  });
});

test("Dynadot withdrawal sends not_for_sale without pricing parameters", async () => {
  await withDynadot({ SetForSaleResponse: { Status: "success", ResponseCode: 0 } }, async (execute, requests) => {
    expect((await execute("remove_for_sale", { domain: "example.com" })).success).toBe(true);
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      command: "set_for_sale", for_sale_type: "not_for_sale", domains: "example.com",
      key: "test-key&with=reserved+characters",
    });
  });
});

test("Dynadot does not report HTTP 200 listing errors as successful sales", async () => {
  const response = { SetForSaleResponse: { ResponseCode: -1, Status: "error", Error: "Domain is not in your account" } };
  await withDynadot(response, async execute => {
    const result = await execute("set_for_sale", { domain: "example.com", listing_type: "buy_now", price: "1000.00" });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "upstream_api_error", message: "Domain is not in your account", provider_error: response,
    });
  });
});

test("Dynadot repairs search, transfer, and additive DNS parameter names", async () => {
  const cases: [string, Record<string, unknown>, string, string, Record<string, string>][] = [
    ["search_domain", { domain: "example.com" }, "search", "SearchResponse", { domain0: "example.com", show_price: "1" }],
    ["bulk_search", { domain0: "example.com", domain1: "example.net", domain99: "example.org" }, "search", "SearchResponse", { domain0: "example.com", domain1: "example.net", domain99: "example.org", show_price: "1" }],
    ["transfer_domain", { domain: "example.com", authcode: "EPP&code+" }, "transfer", "TransferResponse", { domain: "example.com", auth: "EPP&code+" }],
    ["set_dns_record", { domain: "example.com", recordType: "mx", recordValue: "mail.example.com", recordExtra: "10", ttl: "300" }, "set_dns2", "SetDnsResponse", { domain: "example.com", main_record_type0: "mx", main_record0: "mail.example.com", main_recordx0: "10", ttl: "300", add_dns_to_current_setting: "1" }],
    ["list_domains", {}, "list_domain", "ListDomainInfoResponse", {}],
    ["get_domain_info", { domain: "example.com" }, "domain_info", "DomainInfoResponse", { domain: "example.com" }],
    ["get_dns", { domain: "example.com" }, "get_dns", "GetDnsResponse", { domain: "example.com" }],
    ["register_domain", { domain: "example.com", duration: "1" }, "register", "RegisterResponse", { domain: "example.com", duration: "1" }],
    ["renew_domain", { domain: "example.com", duration: "1" }, "renew", "RenewResponse", { domain: "example.com", duration: "1" }],
    ["set_nameservers", { domain: "example.com", ns0: "ns1.example.com", ns1: "ns2.example.com" }, "set_ns", "SetNsResponse", { domain: "example.com", ns0: "ns1.example.com", ns1: "ns2.example.com" }],
  ];
  for (const [name, input, command, root, params] of cases) {
    await withDynadot({ [root]: { ResponseCode: "0", Status: "success" } }, async (execute, requests) => {
      expect((await execute(name, input)).success).toBe(true);
      expect(requests[0].url.pathname).toBe("/api3.json");
      expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
        command, key: "test-key&with=reserved+characters", ...params,
      });
    });
  }
});

test("Dynadot source and server embedded catalogs match", async () => {
  const embedded = await Bun.file(new URL("../../server/integrations-catalog/dynadot.json", import.meta.url)).json();
  expect(embedded).toEqual(dynadot);
});
