import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { getAppTemplate } from '../src/apps/index.js';
import { executeTool } from '../src/http-executor.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key.privateKey.export({type:'pkcs8',format:'pem'}).toString();
function run(slug:string, name:string, input:Record<string,unknown>, fields:Record<string,string>) {
 const app=getAppTemplate(slug)!;
 return executeTool({app,tool:app.tools.find(t=>t.name===name)!,input,credentials:{fields}});
}

test('Enable Banking signs a verifiable JWT and preserves pagination without exposing credentials', async()=>{
 let url=''; let headers:Record<string,string>={};
 const response={transactions:[],continuation_key:'next-page'};
 globalThis.fetch=(async(u,o)=>{url=String(u);headers=o!.headers as Record<string,string>;return Response.json(response);}) as typeof fetch;
 const result=await run('enable-banking','get_account_transactions',{account_id:'account-1',date_from:'2026-09-01',continuation_key:'page +/='},{application_id:'app-1',private_key:pem.replace(/\n/g,'\\n')});
 const parts=headers.Authorization!.slice(7).split('.');
 expect(JSON.parse(Buffer.from(parts[0]!,'base64url').toString())).toEqual({alg:'RS256',typ:'JWT',kid:'app-1'});
 const claims=JSON.parse(Buffer.from(parts[1]!,'base64url').toString());
 expect(claims.iss).toBe('enablebanking.com');expect(claims.aud).toBe('api.enablebanking.com');expect(claims.exp-claims.iat).toBe(900);
 expect(verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),key.publicKey,Buffer.from(parts[2]!,'base64url'))).toBe(true);
 const parsed=new URL(url);expect(parsed.pathname).toBe('/accounts/account-1/transactions');expect(parsed.searchParams.get('continuation_key')).toBe('page +/=');
 expect(url).not.toContain('private_key');expect(url).not.toContain('app-1');expect(headers['Psu-Ip-Address']).toBeUndefined();expect(result.data).toEqual(response);
});

test('Enable Banking sends nested authorization access and bank selection intact',async()=>{
 let body:any;
 globalThis.fetch=(async(_u,o)=>{body=JSON.parse(String(o!.body));return Response.json({url:'https://auth.enablebanking.com/ais/start'});}) as typeof fetch;
 const input={access:{valid_until:'2026-10-01T00:00:00Z',balances:true,transactions:true},aspsp:{name:'BBVA',country:'ES'},state:'random-state',redirect_url:'https://example.com/callback',psu_type:'personal'};
 await run('enable-banking','start_authorization',input,{application_id:'app-1',private_key:pem});expect(body).toEqual(input);
});

test('Enable Banking rejects absent credentials and non-RSA private keys before HTTP',async()=>{
 let called=false;globalThis.fetch=(async()=>{called=true;return Response.json({});}) as typeof fetch;
 await expect(run('enable-banking','get_application',{},{})).rejects.toThrow('requires application_id');
 const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
 await expect(run('enable-banking','get_application',{},{application_id:'app-1',private_key:ec})).rejects.toThrow('RSA private key');expect(called).toBe(false);
});

test('Yapily uses Basic app credentials and consent headers, retaining pagination metadata',async()=>{
 let url='';let headers:Record<string,string>={};
 const response={data:[],meta:{pagination:{totalCount:250}}};
 globalThis.fetch=(async(u,o)=>{url=String(u);headers=o!.headers as Record<string,string>;return Response.json(response);}) as typeof fetch;
 const result=await run('yapily','get_account_transactions',{accountId:'a1',consent:'bank-consent',psu_ip_address:'192.0.2.1',limit:100,offset:100},{username:'app-id',password:'app-secret'});
 expect(headers.Authorization).toBe('Basic '+Buffer.from('app-id:app-secret').toString('base64'));expect(headers.consent).toBe('bank-consent');expect(headers['psu-ip-address']).toBe('192.0.2.1');
 const parsed=new URL(url);expect(parsed.pathname).toBe('/accounts/a1/transactions');expect(parsed.searchParams.get('offset')).toBe('100');expect(url).not.toContain('consent');expect(url).not.toContain('app-secret');expect(url).not.toContain('192.0.2.1');expect(result.data).toEqual(response);
});

test('Yapily exchanges one-time tokens in JSON and sends bodyless reauthorization',async()=>{
 const requests:{url:string,body:unknown,headers:Record<string,string>}[]=[];
 globalThis.fetch=(async(u,o)=>{requests.push({url:String(u),body:o?.body,headers:o?.headers as Record<string,string>});return Response.json({data:{consentToken:'new-consent'}});}) as typeof fetch;
 const creds={username:'app-id',password:'secret'};
 await run('yapily','exchange_one_time_token',{oneTimeToken:'ott'},creds);
 await run('yapily','reauthorize_account_consent',{consent:'old-consent'},creds);
 expect(requests[0]!.url).toBe('https://api.yapily.com/consent-one-time-token');expect(JSON.parse(String(requests[0]!.body))).toEqual({oneTimeToken:'ott'});expect(requests[0]!.headers.consent).toBeUndefined();expect(requests[1]!.body).toBeUndefined();expect(requests[1]!.headers.consent).toBe('old-consent');
});
