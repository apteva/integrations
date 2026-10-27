import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
const fetchBefore = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchBefore; });
test("Google custom segments use CustomAudienceService with native members and validation", async () => {
 const app = getAppTemplate("google-ads")!;
 const tool = app.tools.find(t => t.name === "custom_audience_mutate")!;
 let request: RequestInit | undefined, url = "";
 globalThis.fetch = (async (target, init) => { url = String(target); request = init; return Response.json({ results: [{ resourceName: "customers/123/customAudiences/45" }] }); }) as typeof fetch;
 const operations = [{ create: { name: "Topics", type: "AUTO", status: "ENABLED", members: [{ memberType: "KEYWORD", keyword: "running shoes" }, { memberType: "URL", url: "https://example.com" }, { memberType: "APP", app: "com.example.app" }] } }];
 const result = await executeTool({ app, tool, input: { customer_id: "123", operations, validateOnly: true, responseContentType: "MUTABLE_RESOURCE" }, credentials: { access_token: "test-token", fields: { developer_token: "test-developer" } } });
 expect(url).toBe("https://googleads.googleapis.com/v23/customers/123/customAudiences:mutate");
 expect(JSON.parse(String(request?.body))).toEqual({ operations, validateOnly: true, responseContentType: "MUTABLE_RESOURCE" });
 expect(result.success).toBe(true);
});
