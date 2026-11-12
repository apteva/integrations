import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
test("Telnyx exposes SMS and profile ownership/setup without changing voice paths",()=>{
 const app=getAppTemplate("telnyx")!;
 const byName=new Map(app.tools.map(t=>[t.name,t]));
 expect(new Set(app.tools.map(t=>t.name)).size).toBe(app.tools.length);
 for(const [name,path,method] of [["send_sms","/messages","POST"],["get_message","/messages/{id}","GET"],["list_messaging_profiles","/messaging_profiles","GET"],["create_messaging_profile","/messaging_profiles","POST"],["get_messaging_profile","/messaging_profiles/{id}","GET"],["update_messaging_profile","/messaging_profiles/{id}","PATCH"],["list_messaging_profile_phone_numbers","/messaging_profiles/{id}/phone_numbers","GET"]]){
  expect(byName.get(name)?.path).toBe(path);expect(byName.get(name)?.method).toBe(method);
 }
 expect(byName.get("update_phone_number_messaging_settings")?.path).toBe("/phone_numbers/{id}/messaging");
 expect(byName.get("update_phone_number_voice_settings")?.path).toBe("/phone_numbers/{id}/voice");
 for(const event of ["message.received","message.sent","message.finalized"]){expect(app.webhooks?.events.some(e=>e.name===event)).toBe(true);}
});
test("SMS text and callbacks survive execution without coercion",async()=>{
 const app=getAppTemplate("telnyx")!;let sent:any;
 globalThis.fetch=(async(url,options)=>{sent={url:String(url),method:options?.method,body:JSON.parse(String(options?.body))};return new Response(JSON.stringify({data:{id:"sms-1"}}),{status:200});}) as typeof fetch;
 await executeTool({app,tool:app.tools.find(t=>t.name==="send_sms")!,credentials:{fields:{token:"test-key"}},input:{from:"+15550001111",to:"+15550002222",text:"Your code is 001234",webhook_url:"https://example.com/callback",type:"SMS"}});
 expect(sent.url).toBe("https://api.telnyx.com/v2/messages");expect(sent.method).toBe("POST");expect(sent.body.text).toBe("Your code is 001234");expect(sent.body.from).toBe("+15550001111");expect(sent.body.webhook_url).toBe("https://example.com/callback");
});
test("profile patch is scoped to the selected profile and supplied settings",async()=>{
 const app=getAppTemplate("telnyx")!;let sent:any;
 globalThis.fetch=(async(url,options)=>{sent={url:String(url),method:options?.method,body:JSON.parse(String(options?.body))};return new Response(JSON.stringify({data:{id:"profile-1"}}),{status:200});}) as typeof fetch;
 await executeTool({app,tool:app.tools.find(t=>t.name==="update_messaging_profile")!,credentials:{fields:{token:"test-key"}},input:{id:"profile-1",webhook_url:"https://example.com/inbound"}});
 expect(sent.url).toBe("https://api.telnyx.com/v2/messaging_profiles/profile-1");expect(sent.method).toBe("PATCH");expect(sent.body).toEqual({webhook_url:"https://example.com/inbound"});
});
