import {describe,test,expect} from 'bun:test';
import {getAppTemplate} from '../src/apps/index.js';
import {executeTool} from '../src/http-executor.js';
const app=getAppTemplate('ovhcloud')!;
const tool=(name:string)=>{const found=app.tools.find(t=>t.name===name);if(!found)throw Error(name);return found;};
describe('OVH compute product contracts',()=>{
 test('keeps existing Public Cloud names and declares VPS, dedicated, Eco and storage capabilities',()=>{
  expect(new Set(app.tools.map(t=>t.name)).size).toBe(app.tools.length);
  for(const name of ['create_instance','get_instance','delete_instance','cart_vps_add','cart_dedicated_add','cart_eco_add','vps_rebuild','dedicated_reinstall','vps_terminate','dedicated_terminate','vps_termination_confirm','dedicated_termination_confirm','resize_instance','create_regional_instance','instance_snapshot_create','volume_snapshot_get','object_bucket_create','object_user_policy_set'])expect(tool(name)).toBeDefined();
  expect(app.auth.credential_fields?.find(f=>f.name==='api_endpoint')?.default).toBe('https://eu.api.ovh.com/1.0');
  expect(app.auth.credential_fields?.find(f=>f.name==='service_name')?.required).toBe(false);
  for(const t of app.tools){
   for(const match of t.path.matchAll(/(?<!\{)\{([\w]+)\}(?!\})/g)){
    expect(t.input_schema.properties?.[match[1]],`${t.name} missing path parameter ${match[1]}`).toBeDefined();
    expect(t.input_schema.required||[],`${t.name} optional path parameter`).toContain(match[1]);
   }
  }
 });
 test('places query, path and nested bodies correctly on EU, CA and US endpoints',async()=>{
  const original=globalThis.fetch;const requests:Array<{url:string,method:string,body:any,auth:string|null}>=[];
  globalThis.fetch=(async(url:any,init:any)=>{requests.push({url:String(url),method:init.method,body:init.body?JSON.parse(init.body):null,auth:new Headers(init.headers).get('authorization')});return new Response('{}',{headers:{'content-type':'application/json'}});}) as typeof fetch;
  try{
   for(const endpoint of ['https://eu.api.ovh.com/1.0','https://ca.api.ovh.com/1.0','https://api.us.ovhcloud.com/1.0']){
    const credentials={fields:{access_token:'fixture-secret',service_name:'project-1',api_endpoint:endpoint}};
    const run=(name:string,input:Record<string,unknown>)=>executeTool({app,tool:tool(name),credentials,input});
    const start=requests.length;
    await run('vps_catalog',{ovhSubsidiary:'ES'});
    await run('cart_dedicated_add',{cartId:'cart-1',duration:'P1M',planCode:'bare-metal-plan',pricingMode:'default',quantity:1});
    await run('cart_checkout',{cartId:'cart-1',autoPayWithPreferredPaymentMethod:true,waiveRetractationPeriod:false});
    await run('vps_rebuild',{serviceName:'vps.example.net',imageId:'image-1',publicSshKey:'ssh-ed25519 example',postInstallScript:'#!/bin/sh\ntrue',installRTM:false,doNotSendPassword:true});
    await run('dedicated_reinstall',{serviceName:'dedicated.example.net',operatingSystem:'ubuntu2404_64',customizations:{sshKey:'ssh-ed25519 example',configDriveUserData:'Y2xvdWQ='}});
    await run('dedicated_termination_confirm',{serviceName:'dedicated.example.net',token:'email-secret'});
    await run('create_regional_instance',{regionName:'EU-SOUTH-MAD-A',billingPeriod:'hourly',flavor:{id:'flavor-1'},bootFrom:{imageId:'image-1'},network:{public:true},volume:{size:80,type:'classic'}});
    await run('get_region_operation',{operationId:'operation-1'});
    await run('volume_snapshot_get',{snapshotId:'snapshot-1'});
    expect(requests[start].url).toBe(`${endpoint}/order/catalog/public/vps?ovhSubsidiary=ES`);
    expect(requests[start+1]).toMatchObject({url:`${endpoint}/order/cart/cart-1/baremetalServers`,method:'POST',body:{duration:'P1M',planCode:'bare-metal-plan',pricingMode:'default',quantity:1}});
    expect(requests[start+1].body.cartId).toBeUndefined();
    expect(requests[start+2].body).toEqual({autoPayWithPreferredPaymentMethod:true,waiveRetractationPeriod:false});
    expect(requests[start+3].body.publicSshKey).toBe('ssh-ed25519 example');
    expect(requests[start+4].body.customizations).toEqual({sshKey:'ssh-ed25519 example',configDriveUserData:'Y2xvdWQ='});
    expect(requests[start+5].body).toEqual({token:'email-secret'});
    expect(requests[start+6].body).toMatchObject({network:{public:true},bootFrom:{imageId:'image-1'},volume:{size:80,type:'classic'}});
    expect(requests[start+7].url).toBe(`${endpoint}/cloud/project/project-1/operation/operation-1`);
    expect(requests[start+8].url).toBe(`${endpoint}/cloud/project/project-1/volume/snapshot/snapshot-1`);
   }
   expect(requests.every(r=>r.auth==='Bearer fixture-secret')).toBe(true);
  }finally{globalThis.fetch=original;}
 });
});
