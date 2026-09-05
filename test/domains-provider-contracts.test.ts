import {expect,test} from 'bun:test';
import porkbun from '../src/apps/porkbun.json';
import {executeTool} from '../src/http-executor';
import type {AppTemplate,AppToolTemplate} from '../src/types';

test('Porkbun registration requires a confirmed cost and stable request ID',()=>{
 const tool=porkbun.tools.find(t=>t.name==='register_domain')!;
 expect(tool.input_schema.required).toEqual(['domain','cost','agreeToTerms','idempotency_key']);
 for(const unsupported of ['years','coupon','renewAuto'])expect(tool.input_schema.properties).not.toHaveProperty(unsupported);
 expect(tool.header_params).toEqual({idempotency_key:'Idempotency-Key'});
});

test('Porkbun dry run and purchase use exact JSON types and a header-only idempotency key',async()=>{
 const captured:{url:string;headers:Headers;body:any}[]=[];
 const server=Bun.serve({port:0,fetch:async req=>{captured.push({url:req.url,headers:req.headers,body:await req.json()});return Response.json({status:'SUCCESS'})}});
 try {
 for(const dryRun of [true,false]) {
 const result=await executeTool({app:{...porkbun,base_url:`http://127.0.0.1:${server.port}`} as AppTemplate,tool:porkbun.tools.find(t=>t.name==='register_domain') as AppToolTemplate,credentials:{api_key:'test-key',secret_api_key:'test-secret'},input:{domain:'example.com',cost:1106,agreeToTerms:'yes',whoisPrivacy:true,dryRun,idempotency_key:dryRun?'preview-test':'purchase-test'}});
 expect(result.success).toBe(true);
 }
 expect(captured).toHaveLength(2);
 captured.forEach((r,i)=>{expect(new URL(r.url).pathname).toBe('/domain/create/example.com');expect(r.headers.get('Idempotency-Key')).toBe(i?'purchase-test':'preview-test');expect(r.headers.get('X-API-Key')).toBe('test-key');expect(r.body).toEqual({cost:1106,agreeToTerms:'yes',whoisPrivacy:true,dryRun:i===0});});
 }finally{server.stop(true)}
});
