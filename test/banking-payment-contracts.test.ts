import {afterEach,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {getAppTemplate} from '../src/apps/index.js';
import {executeTool} from '../src/http-executor.js';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
async function request(slug:string,name:string,input:Record<string,unknown>,response:unknown={}) {
 const app=getAppTemplate(slug)!;const tool=app.tools.find(t=>t.name===name)!;
 let captured:{url:string,body:any,headers:Record<string,string>}|undefined;
 globalThis.fetch=(async(u,o)=>{captured={url:String(u),body:JSON.parse(String(o?.body||'{}')),headers:o?.headers as Record<string,string>};return Response.json(response);}) as typeof fetch;
 const result=await executeTool({app,tool,input,credentials:{fields:slug==='plaid'?{client_id:'client',secret:'secret',environment:'sandbox'}:{username:'token',password:'x'}}});
 return {...captured!,result};
}
for(const name of ['get_accounts','get_balances','get_identity','get_auth','get_investments_holdings','get_liabilities','get_transactions','get_investments_transactions']) {
 test(`Plaid ${name} sends legacy filters in options and preserves credentials`,async()=>{
  const paged=name==='get_transactions'||name==='get_investments_transactions';
  const input={access_token:'item',account_ids:['account'],...(paged?{start_date:'2026-09-01',end_date:'2026-09-15',count:25,offset:50}:{})};
  const {body}=await request('plaid',name,input);
  expect(body.options).toEqual({account_ids:['account'],...(paged?{count:25,offset:50}:{})});
  expect(body.account_ids).toBeUndefined();expect(body.count).toBeUndefined();expect(body.offset).toBeUndefined();expect(body.client_id).toBe('client');expect(body.secret).toBe('secret');expect(body.access_token).toBe('item');
  if(paged){expect(body.start_date).toBe(input.start_date);expect(body.end_date).toBe(input.end_date);}
 });
}
test('Plaid native options work and explicit aliases override only their fields',async()=>{
 const {body}=await request('plaid','get_transactions',{access_token:'item',start_date:'2026-09-01',end_date:'2026-09-15',options:{account_ids:['a'],count:10,offset:90,include_original_description:true},count:20});
 expect(body.options).toEqual({account_ids:['a'],count:20,offset:90,include_original_description:true});
});
test('Plaid sync and recurring requests retain endpoint-specific top-level fields',async()=>{
 const sync=await request('plaid','sync_transactions',{access_token:'item',count:50,cursor:'cursor',options:{account_id:'a'}});
 expect(sync.body.count).toBe(50);expect(sync.body.cursor).toBe('cursor');expect(sync.body.options).toEqual({account_id:'a'});
 const recurring=await request('plaid','get_recurring_transactions',{access_token:'item',account_ids:['a']});expect(recurring.body.account_ids).toEqual(['a']);
 const app=getAppTemplate('plaid')!;expect(app.tools.find(t=>t.name==='sync_transactions')!.input_schema.properties).not.toHaveProperty('account_ids');expect(app.tools.find(t=>t.name==='search_institutions')!.input_schema.properties).not.toHaveProperty('offset');
});
test('Plaid payment user and payment-specific Link configuration reach official endpoints',async()=>{
 const payment=await request('plaid','create_payment',{user_id:'user-1',recipient_id:'recipient',reference:'invoice',amount:{currency:'EUR',value:10}});expect(payment.body.user_id).toBe('user-1');
 const link=await request('plaid','create_link_token',{client_name:'Finance',language:'es',country_codes:['ES'],user_id:'user-1',products:['payment_initiation'],payment_initiation:{payment_id:'payment-1'},hosted_link:{completion_redirect_uri:'https://example.com/done'}});
 expect(link.url).toBe('https://sandbox.plaid.com/link/token/create');expect(link.body.payment_initiation).toEqual({payment_id:'payment-1'});expect(link.body.hosted_link.completion_redirect_uri).toBe('https://example.com/done');expect(link.body.user_id).toBe('user-1');
 const user=await request('plaid','create_user',{client_user_id:'internal-1',identity:{name:{given_name:'Test',family_name:'User'}}});expect(user.url).toBe('https://sandbox.plaid.com/user/create');
});
test('Plaid transfer calls retain stable idempotency keys',async()=>{
 for(const name of ['create_transfer_authorization','create_transfer']){const {body}=await request('plaid',name,{idempotency_key:'intent-1'});expect(body.idempotency_key).toBe('intent-1');}
});
test('Teller payment uses JSON nested payee and header idempotency, preserving MFA response',async()=>{
 const payee={scheme:'zelle',address:'recipient@example.com'};
 const {body,headers,result}=await request('teller','create_payment',{account_id:'a',amount:'10.48',memo:'Invoice',payee,idempotency_key:'intent-1'},{connect_token:'mfa-challenge'});
 expect(headers['Content-Type']).toBe('application/json');expect(headers['Idempotency-Key']).toBe('intent-1');expect(body).toEqual({amount:'10.48',memo:'Invoice',payee});expect(result.data).toEqual({connect_token:'mfa-challenge'});
 const t=getAppTemplate('teller')!.tools.find(t=>t.name==='create_payment')!;expect(t.input_schema.required).toContain('idempotency_key');expect(t.input_schema.properties).not.toHaveProperty('payee_id');
});
test('Teller payee creation sends JSON',async()=>{
 const {body,headers}=await request('teller','create_payee',{account_id:'a',scheme:'zelle',address:'recipient@example.com',name:'Recipient',type:'person'});expect(headers['Content-Type']).toBe('application/json');expect(body).toEqual({scheme:'zelle',address:'recipient@example.com',name:'Recipient',type:'person'});
});
test('Nordigen has no unsupported payment routes and all mirrors match',()=>{
 expect(getAppTemplate('nordigen')!.tools.some(t=>t.path.startsWith('/payments'))).toBe(false);
 for(const slug of ['plaid','teller','nordigen'])expect(readFileSync(new URL(`../src/apps/${slug}.json`,import.meta.url),'utf8')).toBe(readFileSync(new URL(`../../server/integrations-catalog/${slug}.json`,import.meta.url),'utf8'));
});
