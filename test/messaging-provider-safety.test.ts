import { afterEach, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch});
test("SES in-place receipt updates preserve extra actions and do not inject defaults",async()=>{
 const app=getAppTemplate("aws-ses")!;
 const tool=app.tools.find(t=>t.name==="update_receipt_rule")!;
 expect(tool.path).toContain("Action=UpdateReceiptRule");
 expect(app.tools.find(t=>t.name==="describe_receipt_rule")?.path).toContain("Action=DescribeReceiptRule");
 for(const property of Object.values(tool.input_schema.properties||{}))expect(property).not.toHaveProperty("default");
 let captured="";
 globalThis.fetch=(async(url:any)=>{captured=String(url);return new Response("{}",{status:200,headers:{"Content-Type":"application/json"}})}) as any;
 await executeTool({app,tool,credentials:{access_token:"",fields:{access_key_id:"TEST",secret_access_key:"TEST",region:"eu-west-1"}},input:{RuleSetName:"existing", "Rule.Name":"inbound","Rule.Enabled":"false","Rule.Actions.member.1.LambdaAction.FunctionArn":"arn:aws:lambda:eu-west-1:123:function:existing","Rule.Actions.member.3.StopAction.Scope":"RuleSet","Rule.Recipients.member.2":"new.example.com"}});
 const q=new URL(captured).searchParams;
 expect(q.get("Rule.Enabled")).toBe("false");expect(q.get("Rule.Actions.member.3.StopAction.Scope")).toBe("RuleSet");expect(q.get("Rule.Recipients.member.2")).toBe("new.example.com");expect(q.has("Rule.Actions.member.2.SNSAction.Encoding")).toBe(false);
});
test("both Twilio inventories pass their continuation token",async()=>{
 const app=getAppTemplate("twilio")!;
 for(const name of ["list_phone_numbers","list_whatsapp_senders"]){
  const tool=app.tools.find(t=>t.name===name)!;expect(tool.input_schema.properties?.PageToken).toBeTruthy();
  let captured="";globalThis.fetch=(async(url:any)=>{captured=String(url);return new Response("{}",{status:200,headers:{"Content-Type":"application/json"}})}) as any;
  await executeTool({app,tool,credentials:{access_token:"",fields:{account_sid:"ACtest",auth_token:"test"}},input:{PageToken:"next+page",PageSize:100}});
  expect(new URL(captured).searchParams.get("PageToken")).toBe("next+page");
 }
});
