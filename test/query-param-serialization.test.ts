import { afterEach, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import { getAppTemplate } from "../src/apps/index.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const app = { slug: "test", base_url: "https://example.test", auth: { types: [] }, tools: [] } as unknown as AppTemplate;
for (const method of ["GET", "POST"] as const) {
  test(`${method} opts into CSV per input, honors aliases and leaves other arrays repeated`, async () => {
    let received: URL | undefined;
    let body: unknown;
    globalThis.fetch = (async (url, init) => { received = new URL(String(url)); body = init?.body; return Response.json({}); }) as typeof fetch;
    const tool = { name: "test", method, path: "/test", query_params: ["metrics", "ids", "ranges"], query_param_aliases: { metrics: "metric_types" }, query_param_serialization: { metrics: "csv", ids: "csv" }, input_schema: { type: "object", properties: {} } } as AppToolTemplate;
    await executeTool({ app, tool, credentials: {}, input: { metrics: ["IMPRESSION", "PIN_CLICK", "OUTBOUND_CLICK", "SAVE"], ids: ["a&b", "c d"], ranges: ["a", "b"], extra: "body" } });
    expect(received!.searchParams.getAll("metric_types")).toEqual(["IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE"]);
    expect(received!.searchParams.getAll("ids")).toEqual(["a&b,c d"]);
    expect(received!.searchParams.getAll("ranges")).toEqual(["a", "b"]);
    if (method === "POST") expect(JSON.parse(String(body))).toEqual({ extra: "body" });
  });
}
test("generic GET arrays and empty/scalar CSV inputs", async () => {
  let query: URLSearchParams;
  globalThis.fetch = (async url => { query = new URL(String(url)).searchParams; return Response.json({}); }) as typeof fetch;
  const tool = { name: "test", method: "GET", path: "/test", query_param_serialization: { ids: "csv", scalar: "csv", empty: "csv" }, input_schema: { type: "object", properties: {} } } as AppToolTemplate;
  await executeTool({app, tool, credentials: {}, input: { ids: ["1", null, "2"], scalar: "one", empty: [], ranges: ["a", "b"] }});
  expect(query!.get("ids")).toBe("1,2"); expect(query!.get("scalar")).toBe("one"); expect(query!.has("empty")).toBe(false); expect(query!.getAll("ranges")).toEqual(["a", "b"]);
});
test("Pinterest analytics retain array schemas and opt into CSV", () => {
  const pinterest = getAppTemplate("pinterest")!;
  for (const tool of pinterest.tools.filter(t => t.query_params?.includes("metric_types"))) {
    expect(tool.input_schema.properties?.metric_types.type).toBe("array");
    expect(tool.query_param_serialization?.metric_types).toBe("csv");
    if (tool.query_params?.includes("pin_ids")) expect(tool.query_param_serialization?.pin_ids).toBe("csv");
  }
});

test("generated descriptors preserve query encoding metadata", async () => {
  const { generateMcpServer } = await import("../src/mcp-generator.js");
  const pinterest=getAppTemplate("pinterest")!;
  const server=generateMcpServer({id:"test",credentials:{access_token:"test",fields:{}}} as any,pinterest);
  expect(server.tools.find(t=>t.name==="pinterest_get_multiple_pin_analytics")!.http_config.query_param_serialization).toEqual({metric_types:"csv",pin_ids:"csv"});
});

test("configured CSV rejects nested values and unsupported modes before dispatch", async () => {
  let requests=0;globalThis.fetch=(async()=>{requests++;return Response.json({});}) as typeof fetch;
  for(const [mode,value] of [["csv",[{nested:true}]],["invalid",["a"]]] as const){
    const tool={name:"test",method:"GET",path:"/test",query_param_serialization:{ids:mode},input_schema:{type:"object",properties:{}}} as unknown as AppToolTemplate;
    await expect(executeTool({app,tool,credentials:{},input:{ids:value}})).rejects.toThrow();
  }
  expect(requests).toBe(0);
});
