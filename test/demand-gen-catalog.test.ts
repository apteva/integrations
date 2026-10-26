import {afterEach,test,expect} from "bun:test";
import {getAppTemplate} from "../src/apps/index.js";
import {executeTool} from "../src/http-executor.js";
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch});
test("Google mutation validation preserves native operations and does not drop validation controls",async()=>{
 const app=getAppTemplate("google-ads")!;const tool=app.tools.find(t=>t.name==="bulk_mutate")!;
 const operations=[{campaignOperation:{create:{name:"Paused Demand Gen",advertisingChannelType:"DEMAND_GEN",status:"PAUSED"}}}];
 let request:RequestInit|undefined;
 globalThis.fetch=(async(_url,init)=>{request=init;return Response.json({})}) as typeof fetch;
 const result=await executeTool({app,tool,input:{customer_id:"1234567890",mutateOperations:operations,validateOnly:true,responseContentType:"MUTABLE_RESOURCE",partialFailure:false},credentials:{access_token:"test-token",fields:{developer_token:"test-developer"}}});
 expect(JSON.parse(String(request?.body))).toEqual({mutateOperations:operations,validateOnly:true,responseContentType:"MUTABLE_RESOURCE",partialFailure:false});
 expect(result.success).toBe(true);
 const schema=tool.input_schema.properties as Record<string,unknown>;
 expect(schema).toHaveProperty("validateOnly");expect(schema).toHaveProperty("responseContentType");
});
