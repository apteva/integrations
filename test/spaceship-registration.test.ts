import { expect, test } from 'bun:test';
import spaceship from '../src/apps/spaceship.json';
import {executeTool} from '../src/http-executor';
import {generateMcpServer} from '../src/mcp-generator';
import type {AppTemplate, AppToolTemplate, Connection} from '../src/types';

const registration = spaceship.tools.find(t => t.name === 'register_domain') as AppToolTemplate;
const contact = '1ZdMXpapqp9sle5dl8BlppTJXAzf5';
test('Spaceship registration preserves empty-202 operation header and sends documented body', async () => {
 let captured: {url:string;body:unknown;headers:Headers}|undefined;
 const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:async req => {captured={url:req.url,body:await req.json(),headers:req.headers};return new Response(null,{status:202,headers:{'Spaceship-Async-OperationId':'operation123','Set-Cookie':'private=secret'}})}});
 try {
  const options={autoRenew:false,years:2,privacyProtection:{level:'high',userConsent:true},contacts:{registrant:contact}};
  const result=await executeTool({app:{...spaceship,base_url:`http://127.0.0.1:${server.port}`} as AppTemplate,tool:registration,credentials:{api_key:'test-key',api_secret:'test-secret'},input:{domain:'example.com',...options}});
  expect(result.success).toBe(true);expect(result.status).toBe(202);expect(result.data).toEqual({operation_id:'operation123'});
  expect(new URL(captured!.url).pathname).toBe('/v1/domains/example.com');expect(captured!.body).toEqual(options);expect(captured!.headers.get('x-api-key')).toBe('test-key');expect(captured!.headers.get('x-api-secret')).toBe('test-secret');
 } finally {server.stop(true)}
});
test('Spaceship never auto-retries a billable registration and exposes required options', () => {
 expect(registration.rate_limit?.max_retries).toBe(0);
 expect(registration.input_schema.required).toEqual(['domain','autoRenew','years','privacyProtection','contacts']);
 expect(registration.response_header_fields).toEqual({'spaceship-async-operationid':'operation_id'});
});
test('Missing operation header does not fabricate an accepted operation',async()=>{
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(null,{status:202})});
 try{const result=await executeTool({app:{...spaceship,base_url:`http://127.0.0.1:${server.port}`} as AppTemplate,tool:registration,credentials:{api_key:'x',api_secret:'y'},input:{domain:'example.com',autoRenew:true,years:1,privacyProtection:{level:'high',userConsent:true},contacts:{registrant:contact}}});expect(result.data).toEqual({});}finally{server.stop(true)}
});

test('Generated tools retain async header mapping',()=>{
 const generated=generateMcpServer({id:1,credentials:{type:'api_key',fields:{api_key:'test',api_secret:'test'}}} as unknown as Connection, {...spaceship,tools:[registration]} as AppTemplate);
 const tool=generated.tools.find(t=>t.name==='spaceship_register_domain');
 expect(tool?.http_config.response_header_fields).toEqual({'spaceship-async-operationid':'operation_id'});
});

test('A throttled purchase is not retried automatically',async()=>{
 let requests=0;const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>{requests++;return Response.json({error:'rate limit'},{status:429})}});
 try {const result=await executeTool({app:{...spaceship,base_url:`http://127.0.0.1:${server.port}`} as AppTemplate,tool:registration,credentials:{api_key:'x',api_secret:'y'},input:{domain:'example.com',autoRenew:true,years:1,privacyProtection:{level:'high',userConsent:true},contacts:{registrant:contact}}});expect(result.success).toBe(false);expect(requests).toBe(1);}finally{server.stop(true)}
});
