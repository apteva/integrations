import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
async function capture(slug:string,name:string,input:Record<string,unknown>){
 const app=getAppTemplate(slug)!;const tool=app.tools.find(t=>t.name===name)!;expect(tool).toBeDefined();const previous=globalThis.fetch;let captured:any;
 globalThis.fetch=async(url,init)=>{captured={url:String(url),method:init?.method,body:init?.body?JSON.parse(String(init.body)):undefined};return new Response('{}',{status:200,headers:{'content-type':'application/json'}})};
 try{const out=await executeTool({app,tool,credentials:{fields:{api_key:'fixture',token:'fixture'}},input});expect(out.success).toBe(true);return captured}finally{globalThis.fetch=previous}
}
describe('Instances managed-firewall provider contracts',()=>{
 test('Clouding includes required descriptions and uses body-free attachment actions',async()=>{
  const input={name:'apteva-fw-test',description:'managed'};expect((await capture('clouding','firewall_create',input)).body).toEqual(input);
  const rule={id:'fw',protocol:'udp',description:'relay',sourceIp:'0.0.0.0/0',portRangeMin:49160,portRangeMax:49223};const r=await capture('clouding','firewall_rule_create',rule);expect(r.url).toBe('https://api.clouding.io/v1/firewalls/fw/rules');expect(r.body).toEqual({...rule,id:undefined});
  const a=await capture('clouding','firewall_attach',{server_id:'host',id:'fw'});expect(a.url).toBe('https://api.clouding.io/v1/servers/host/firewall/fw/attach');expect(a.body).toBeUndefined();
  expect((await capture('clouding','firewall_rule_enable',{rule_id:'r1'})).url).toBe('https://api.clouding.io/v1/firewalls/rules/r1/enable');
 });
 test('DigitalOcean detaches a host using a DELETE JSON body',async()=>{
  const a=await capture('digitalocean','firewall_detach',{id:'fw',body:{droplet_ids:[42]}});expect(a.url).toBe('https://api.digitalocean.com/v2/firewalls/fw/droplets');expect(a.method).toBe('DELETE');expect(a.body).toEqual({droplet_ids:[42]});
  const input={id:'fw',name:'owned',inbound_rules:[],outbound_rules:[],droplet_ids:[42],tags:[]};const r=await capture('digitalocean','firewall_set_rules',input);expect(r.method).toBe('PUT');expect(r.body).toEqual({...input,id:undefined});
 });
 test('Hetzner action envelopes preserve numeric server identity',async()=>{
  const r=await capture('hetzner','firewall_attach',{id:'123',apply_to:[{type:'server',server:{id:42}}]});expect(r.url).toBe('https://api.hetzner.cloud/v1/firewalls/123/actions/apply_to_resources');expect(r.body).toEqual({apply_to:[{type:'server',server:{id:42}}]});
 });
 test('Vultr supports isolated firewall groups on virtual and bare-metal hosts',async()=>{
  for(const [tool,path] of [['firewall_attach','instances'],['firewall_metal_attach','bare-metals']]){const r=await capture('vultr',tool,{server_id:'host',firewall_group_id:'fw'});expect(r.method).toBe('PATCH');expect(r.url).toBe(`https://api.vultr.com/v2/${path}/host`);expect(r.body).toEqual({firewall_group_id:'fw'})}
  const r=await capture('vultr','firewall_rule_create',{id:'fw',ip_type:'v4',protocol:'udp',port:'49160:49223',subnet:'0.0.0.0',subnet_size:0});expect(r.body.port).toBe('49160:49223');expect(r.body.id).toBeUndefined();
 });
 test('Linode replaces host assignments without changing another firewall',async()=>{
  const r=await capture('linode','firewall_attach',{server_id:'42',firewall_ids:[123]});expect(r.method).toBe('PUT');expect(r.url).toBe('https://api.linode.com/v4/linode/instances/42/firewalls');expect(r.body).toEqual({firewall_ids:[123]});
 });
 test('new schemas have complete required and path parameters',()=>{
  for(const slug of ['clouding','hetzner','digitalocean','vultr','linode']){const app=getAppTemplate(slug)!;const names=new Set<string>();for(const t of app.tools){expect(names.has(t.name)).toBe(false);names.add(t.name);if(!t.name.startsWith('firewall_')&&!['create_firewall','create_firewall_rule'].includes(t.name))continue;const props=t.input_schema.properties as Record<string,unknown>;for(const name of t.input_schema.required??[])expect(props[name]).toBeDefined();for(const [,name]of t.path.matchAll(/\{([^}]+)\}/g))expect(props[name]).toBeDefined()}}
 });
});
