import { test } from "bun:test";
import assert from 'node:assert/strict';
import { getAppTemplate } from '../src/apps/index.ts';
import { executeTool } from '../src/http-executor.ts';
import type { ConnectionCredentials } from '../src/types.ts';

test("Connectivity request and token renewal contracts", async () => {
const originalFetch=globalThis.fetch;
try {
const requests: Array<{url:string, init:RequestInit, headers:Headers}> = [];
let response = Response.json({id:'test-result'});
globalThis.fetch = async (url, init) => {
 requests.push({url:String(url), init:init || {}, headers:new Headers(init?.headers)});
 return response.clone();
};
async function run(slug:string,name:string,input:Record<string,unknown>,fields:Record<string,string>) {
 const app=getAppTemplate(slug)!;
 const tool=app.tools.find(tool=>tool.name===name)!;
 assert(app && tool);
 requests.length=0;
 const result=await executeTool({app,tool,input,credentials:{fields}});
 assert(result.success,JSON.stringify(result));
 assert.equal(requests.length,1);
 return requests[0];
}
let got=await run('telgea','create_number',{userId:'user-1',countryCode:'DK',additionalNumber:false,idempotency_key:'create-1'},{api_key:'test-key'});
assert.equal(got.url,'https://api.telgea.com/v1/numbers');
assert.equal(got.headers.get('x-api-key'),'test-key');
assert.equal(got.headers.get('idempotency-key'),'create-1');
assert.deepEqual(JSON.parse(String(got.init.body)),{userId:'user-1',countryCode:'DK',additionalNumber:false});
got=await run('telgea','resume_number',{numberId:'line/1'},{api_key:'test-key'});
assert.equal(got.url,'https://api.telgea.com/v1/numbers/line%2F1/suspension');
assert.equal(got.init.method,'DELETE');
assert.equal(got.init.body,undefined);
console.log('Telgea provisioning, headers and path encoding passed');
response=new Response(null,{status:204});
got=await run('telna','send_sms',{sim:'8912345678901234567',from:'100',message:'Hello',validity_period:60},{token:'test-key-id'});
assert.equal(got.url,'https://ppo-api.telna.com/v1/a2p-sms/sms-requests');
assert.equal(got.headers.get('authorization'),'Bearer test-key-id');
assert.equal(got.headers.get('content-type'),'application/json');
assert.deepEqual(JSON.parse(String(got.init.body)),{sim:'8912345678901234567',from:'100',message:'Hello',validity_period:60});
response=Response.json({id:'order-1'});
got=await run('telna','create_work_order',{product:'product-1',customer_ref:'customer-1',iccid:'8912345678901234567'},{token:'test-key-id'});
assert.equal(got.url,'https://ppo-api.telna.com/v1/ordering/work-orders');
assert.deepEqual(JSON.parse(String(got.init.body)),{product:'product-1',customer_ref:'customer-1',iccid:'8912345678901234567'});
console.log('Telna ordering and SMS routes, authentication and payloads passed');
got=await run('esim-go','apply_bundle',{name:'esim_1GB_7D_IM_U',iccid:'8912345678901234567',allowReassign:false},{api_key:'test-key'});
assert.equal(got.url,'https://api.esim-go.com/v2.5/esims/apply');
assert.equal(got.headers.get('x-api-key'),'test-key');
assert.deepEqual(JSON.parse(String(got.init.body)),{name:'esim_1GB_7D_IM_U',iccid:'8912345678901234567',allowReassign:false});
got=await run('esim-go','create_order',{type:'validate',assign:false,order:[{type:'bundle',quantity:1,item:'esim_1GB_7D_IM_U'}]},{api_key:'test-key'});
assert.deepEqual(JSON.parse(String(got.init.body)),{type:'validate',assign:false,order:[{type:'bundle',quantity:1,item:'esim_1GB_7D_IM_U'}]});
got=await run('esim-go','send_sms',{iccid:'8912345678901234567',message:'Hello',from:'eSIM'},{api_key:'test-key'});
assert.equal(got.url,'https://api.esim-go.com/v2.5/esims/8912345678901234567/sms');
assert.deepEqual(JSON.parse(String(got.init.body)),{message:'Hello',from:'eSIM'});
console.log('eSIM Go order validation, bundle application and SMS payloads passed');
const app=getAppTemplate('1global')!;
const credentials:ConnectionCredentials={fields:{client_id:'test-client',client_secret:'secret with +&'}};
let exchanges=0;
let rejectNext=false;
globalThis.fetch=async (url,init) => {
 const headers=new Headers(init?.headers);
 if (String(url)===app.auth.token_exchange!.url) {
  exchanges++;
  assert.equal(headers.get('content-type'),'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))),{grant_type:'client_credentials',client_id:'test-client',client_secret:'secret with +&'});
  return Response.json({access_token:'access-'+exchanges,expires_in:3600});
 }
 assert.equal(headers.get('authorization'),'Bearer access-'+exchanges);
 assert.equal(headers.get('api-version'),'2026-02-05');
 const path=new URL(String(url));
 if(path.pathname.endsWith('/orders')) {
  assert.equal(headers.get('idempotency-key'),'order-retry-key');
  assert.equal(headers.get('correlation-id'),'correlation-1');
  assert.deepEqual(JSON.parse(String(init?.body)),{type:'activate_subscription',subscriber_id:'subscriber-1',purchase_location:'DE',sim_profile:{sim_type:'esim'},products:{plan:{product_offering_id:'plan-1'}}});
 } else {
  assert.equal(path.pathname,'/connect/subscriptions');
  assert.equal(path.searchParams.get('subscriber-id'),'subscriber-1');
  assert.equal(path.searchParams.get('account-id'),'account-1');
 }
 if(rejectNext) {rejectNext=false;return Response.json({error:'expired'},{status:401});}
 return Response.json({id:'order-1',status:'accepted'});
};
const input={subscriber_id:'subscriber-1',purchase_location:'DE',sim_profile:{sim_type:'esim'},products:{plan:{product_offering_id:'plan-1'}},idempotency_key:'order-retry-key',correlation_id:'correlation-1'};
let result=await executeTool({app,tool:app.tools.find(tool=>tool.name==='activate_subscription')!,input,credentials});
assert(result.success);assert.equal(exchanges,1);
result=await executeTool({app,tool:app.tools.find(tool=>tool.name==='list_subscriptions')!,input:{account_id:'account-1',subscriber_id:'subscriber-1'},credentials});
assert(result.success);assert.equal(exchanges,1);
rejectNext=true;
result=await executeTool({app,tool:app.tools.find(tool=>tool.name==='activate_subscription')!,input,credentials});
assert(result.success);assert.equal(exchanges,2);
console.log('1GLOBAL token exchange, caching, 401 renewal, idempotency and query aliases passed');
} finally { globalThis.fetch=originalFetch; }
});
