import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const app = getAppTemplate("google-play-developer")!;
const execute = (name: string, input: Record<string, unknown>) => executeTool({
  app,
  tool: app.tools.find((tool) => tool.name === name)!,
  credentials: { fields: { token: "play-test-token", report_bucket: "pubsite_prod_rev_123" } },
  input,
});

test("Google Play report access requests the storage scope and a report bucket", () => {
  expect(app.auth.oauth2?.scopes).toContain("https://www.googleapis.com/auth/devstorage.read_only");
  expect(app.auth.credential_fields?.some((field) => field.name === "report_bucket")).toBe(true);
});

test("Google Play report listing uses the account bucket and preserves pagination", async () => {
  let url: URL | undefined;
  let headers: Headers | undefined;
  globalThis.fetch = async (input, init) => {
    url = new URL(String(input));
    headers = new Headers(init?.headers);
    return Response.json({ items: [{ name: "sales/salesreport_202608.zip" }], nextPageToken: "next" });
  };
  const result = await execute("list_sales_reports", { pageToken: "page+2", maxResults: 100 });
  expect(url?.origin).toBe("https://storage.googleapis.com");
  expect(url?.pathname).toBe("/storage/v1/b/pubsite_prod_rev_123/o");
  expect(url?.searchParams.get("prefix")).toBe("sales/salesreport_");
  expect(url?.searchParams.get("pageToken")).toBe("page+2");
  expect(headers?.get("Authorization")).toBe("Bearer play-test-token");
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({ nextPageToken: "next" });
});

test.each(["get_sales_report", "get_earnings_report"])("%s returns ZIP bytes for an exact month", async (name) => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  let url: URL | undefined;
  globalThis.fetch = async (input) => {
    url = new URL(String(input));
    return new Response(zip, { headers: { "Content-Type": "application/zip" } });
  };
  const result = await execute(name, { year_month: "202608" });
  expect(url?.pathname).toContain(name === "get_sales_report" ? "sales%2Fsalesreport_202608.zip" : "earnings%2Fearnings_202608.zip");
  expect(url?.searchParams.get("alt")).toBe("media");
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({ _binary: true, base64: "UEsDBA==" });
});

test("missing Google Play monthly reports remain 404", async () => {
  globalThis.fetch = async () => Response.json({ error: { code: 404 } }, { status: 404 });
  const result = await execute("get_sales_report", { year_month: "202608" });
  expect(result.success).toBe(false);
  expect(result.status).toBe(404);
});
