import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch});
async function request(slug:string,name:string,input:Record<string,unknown>){
 const app=getAppTemplate(slug)!;const tool=app.tools.find(t=>t.name===name)!;expect(tool).toBeDefined();
 let captured:any;globalThis.fetch=(async(url,init)=>{captured={url:String(url),init};return Response.json({data:[]})}) as typeof fetch;
 await executeTool({app,tool,input,credentials:{access_token:"test-only"}});return captured;
}
test("Meta app discovery uses advertiser edge and explicit fields",async()=>{
 const r=await request("facebook-ads","mobile_app_list",{adAccountId:"act_123",fields:"id,app_install_tracked,advertisable_app_events",limit:100,after:"cursor"});
 const url=new URL(r.url);expect(url.pathname).toBe("/v25.0/act_123/advertisable_applications");expect(url.searchParams.get("after")).toBe("cursor");expect(url.searchParams.get("fields")).toContain("advertisable_app_events");expect(r.init.method).toBe("GET");
});
test("Reddit app discovery and timestamps use current v3 routes",async()=>{
 const r=await request("reddit-ads","list_apps",{ad_account_id:"123", "page.size":200,"page.token":"next"});
 expect(new URL(r.url).pathname).toBe("/api/v3/ad_accounts/123/apps");expect(new URL(r.url).searchParams.get("page.token")).toBe("next");
 const e=await request("reddit-ads","app_last_fired_at",{app_id:"com.example.app"});expect(new URL(e.url).pathname).toBe("/api/v3/apps/com.example.app/last_fired_at_report");
});
test("Reddit app continuation follows only an authenticated same-origin URL",async()=>{
 const next="https://ads-api.reddit.com/api/v3/ad_accounts/123/apps?page.token=next";
 const r=await request("reddit-ads","list_apps",{ad_account_id:"123",next_url:next});expect(r.url).toBe(next);
 await expect(request("reddit-ads","list_apps",{ad_account_id:"123",next_url:"https://attacker.test/apps"})).rejects.toThrow();
});
test("X store identifiers and bidding extend existing line-item schemas",()=>{
 const app=getAppTemplate("twitter-ads")!;
 for(const name of ["create_line_item","update_line_item"]){const t=app.tools.find(t=>t.name===name)!;for(const key of ["ios_app_store_identifier","android_app_store_identifier","goal","bid_strategy"])expect(t.input_schema.properties?.[key]).toEqual({type:"string"});}
 const card=app.tools.find(t=>t.name==="create_card")!;expect(card.input_schema.properties?.components).toMatchObject({type:"array"});
 expect(app.tools.find(t=>t.name==="create_targeting_criteria")?.input_schema.required).toContain("targeting_value");
});
