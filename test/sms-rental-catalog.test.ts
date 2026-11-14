import { test } from "bun:test";
import assert from 'node:assert/strict';
import { getAppTemplate } from '../src/apps/index.ts';
import { executeTool } from '../src/http-executor.ts';

test("SMS rental request contracts", async () => {
const originalFetch=globalThis.fetch;
try {
const cases=[
 {slug:'quackr',name:'purchase_numbers',input:{duration:'oneMonth',locale:'US',quantity:1,receiveCalls:false,autoRenew:false,carrier:'US4',areaCode:'718'},url:'https://api.quackr.io/purchase',body:{duration:'oneMonth',locale:'US',quantity:1,receiveCalls:false,autoRenew:false,carrier:'US4',areaCode:'718'}},
 {slug:'quackr',name:'receive_sms',input:{phoneNumber:'+12025550100'},url:'https://api.quackr.io/receive-sms',body:{phoneNumber:'+12025550100'}},
 {slug:'quackr',name:'purchase_service_number',input:{locale:'US',service:'wa',duration:'oneMonth'},url:'https://api.quackr.io/per-service/purchase',body:{locale:'US',service:'wa',duration:'oneMonth'}},
 {slug:'quackr',name:'list_service_messages',input:{rentId:'rent+1'},url:'https://api.quackr.io/per-service/messages?rentId=rent%2B1'},
 {slug:'fetch-sms',name:'get_quote',input:{service:1,mode:'long',days:30,custom_area_code:false},url:'https://api.fetchsms.com/v1/services/quote?service=1&mode=long&days=30&custom_area_code=false',public:true},
 {slug:'fetch-sms',name:'create_verification',input:{service:4,area_code:'332'},url:'https://api.fetchsms.com/v1/verifications',body:{service:4,area_code:'332'}},
 {slug:'fetch-sms',name:'create_rental',input:{service:1,days:30,area_code:'415'},url:'https://api.fetchsms.com/v1/rentals',body:{service:1,days:30,area_code:'415'}},
 {slug:'fetch-sms',name:'extend_rental',input:{rental_id:'rental-1',days:7},url:'https://api.fetchsms.com/v1/rentals/rental-1/extend',body:{days:7}},
 {slug:'fetch-sms',name:'cancel_rental',input:{rental_id:'rental-1'},url:'https://api.fetchsms.com/v1/rentals/rental-1/cancel'},
 {slug:'fetch-sms',name:'list_verification_messages',input:{verification_id:'verification-1'},url:'https://api.fetchsms.com/v1/verifications/verification-1/messages'},
] as const;
for(const sample of cases) {
 const app=getAppTemplate(sample.slug)!;
 const tool=app.tools.find(tool=>tool.name===sample.name)!;
 let called=false;
 globalThis.fetch=async (url,init) => {
  called=true;
  assert.equal(String(url),sample.url);
  assert.equal(init?.method,tool.method);
  const headers=new Headers(init?.headers);
  assert.equal(headers.get('content-type'),'application/json');
  if(sample.slug==='quackr') assert.equal(headers.get('x-api-key'),'test-key');
  else assert.equal(headers.get('authorization'),'public' in sample ? null:'Bearer test-token');
  if('body' in sample) assert.deepEqual(JSON.parse(String(init?.body)),sample.body);
  else assert.equal(init?.body,undefined);
  return Response.json(sample.slug==='quackr'?{success:true,messages:[]}:{status:'waiting'});
 };
 const result=await executeTool({app,tool,input:sample.input,credentials:{fields:{api_key:'test-key',token:'test-token'}}});
 assert(result.success,JSON.stringify(result));
 assert(called);
}
const app=getAppTemplate('quackr')!;
globalThis.fetch=async()=>Response.json({success:false,error:'Insufficient balance'});
const failure=await executeTool({app,tool:app.tools.find(tool=>tool.name==='purchase_numbers')!,input:{duration:'oneMonth',locale:'US'},credentials:{fields:{api_key:'test-key'}}});
assert.equal(failure.success,false);
assert.equal((failure.data as any).error,'upstream_api_error');
assert.equal((failure.data as any).message,'Insufficient balance');
console.log('10 authenticated request cases, public quote authentication, empty action bodies, and Quackr application errors passed');
} finally { globalThis.fetch=originalFetch; }
});
