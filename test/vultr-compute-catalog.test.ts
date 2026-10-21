import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const app = getAppTemplate("vultr")!;
async function call(name: string, input: Record<string,unknown>) {
 let url=""; let init: RequestInit={};
 globalThis.fetch=(async (target,options)=>{url=String(target);init=options || {};return new Response("{}",{headers:{"content-type":"application/json"}});}) as typeof fetch;
 const tool=app.tools.find(t=>t.name===name)!;
 expect(tool).toBeDefined();
 const r=await executeTool({app,tool,input,credentials:{fields:{token:"test-token"}}});
 expect(r.success).toBe(true);
 expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
 expect(url).not.toContain("test-token");
 return {url:new URL(url),init};
}
test("all compute and metal catalogs preserve pagination without a family whitelist",async()=>{
 for(const [name,path] of [["list_plans","/v2/plans"],["list_metal_plans","/v2/plans-metal"],["list_bare_metals","/v2/bare-metals"]]){
  const {url,init}=await call(name,{per_page:500,cursor:"next+a/="});
  expect(url.pathname).toBe(path);expect(url.searchParams.get("cursor")).toBe("next+a/=");expect(url.searchParams.has("type")).toBe(false);expect(init.method).toBe("GET");
 }
 const {url}=await call("list_region_availability",{region_id:"cdg",type:"vbm"});
 expect(url.pathname).toBe("/v2/regions/cdg/availability");expect(url.searchParams.get("type")).toBe("vbm");
});
test("metal creation and lifecycle use the metal API exclusively",async()=>{
 const payload={region:"cdg",plan:"future-physical-plan",os_id:2284,user_scheme:"root",user_data:"base64-cloud-init",enable_ipv6:true};
 const created=await call("create_bare_metal",payload);
 expect(created.url.pathname).toBe("/v2/bare-metals");expect(JSON.parse(String(created.init.body))).toEqual(payload);
 for(const [name,method,suffix] of [["get_bare_metal","GET",""],["delete_bare_metal","DELETE",""],["start_bare_metal","POST","/start"],["stop_bare_metal","POST","/halt"],["restart_bare_metal","POST","/reboot"]]){
  const {url,init}=await call(name,{baremetal_id:"owned-server"});expect(url.pathname).toBe("/v2/bare-metals/owned-server"+suffix);expect(init.method).toBe(method);expect(url.searchParams.has("baremetal_id")).toBe(false);
 }
});
test("VX1 inline boot volume structure reaches the provider intact",async()=>{
 const block_devices=[{disk_size:80,label:"apteva-boot-owned",bootable:true},{block_id:"local"}];
 const {url,init}=await call("create_instance",{region:"cdg",plan:"vx1-test",os_id:2284,block_devices});
 expect(url.pathname).toBe("/v2/instances");expect(JSON.parse(String(init.body)).block_devices).toEqual(block_devices);
});
