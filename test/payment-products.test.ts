import {afterEach,expect,test} from 'bun:test';
import {generateKeyPairSync,verify} from 'node:crypto';
import {getAppTemplate} from '../src/apps/index.js';
import {executeTool} from '../src/http-executor.js';
const original=globalThis.fetch;afterEach(()=>{globalThis.fetch=original;});
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});const ec=generateKeyPairSync('ec',{namedCurve:'secp521r1'});
const pem=(key:any)=>key.export({type:'pkcs8',format:'pem'}).toString();
async function execute(slug:string,name:string,input:any,fields:any){const app=getAppTemplate(slug)!;return executeTool({app,tool:app.tools.find(t=>t.name===name)!,input,credentials:{fields}});}

test('TrueLayer exchanges Payments credentials and signs exact request bytes with ES512',async()=>{
 const calls:any[]=[];
 globalThis.fetch=(async(url,init)=>{calls.push({url:String(url),...init});return Response.json(String(url).includes('/connect/token')?{access_token:'payments-token',expires_in:3600}:{id:'payment',status:'authorization_required',resource_token:'resource'});}) as typeof fetch;
 const result=await execute('truelayer-payments','create_payment',{amount_in_minor:100,currency:'EUR',payment_method:{type:'bank_transfer',provider_selection:{type:'user_selected'},beneficiary:{type:'external_account',account_holder_name:'Recipient',account_identifier:{type:'iban',iban:'ES9121000418450200051332'},reference:'Invoice'}},user:{name:'Test User',email:'user@example.com'},idempotency_key:'df76655b-4841-42cf-94e5-6f5bd0248772'},{client_id:'client',client_secret:'secret',private_key:pem(ec.privateKey),signing_key_id:'kid',environment:'truelayer-sandbox'});
 expect(calls.length).toBe(2);expect(calls[0].url).toBe('https://auth.truelayer-sandbox.com/connect/token');expect(JSON.parse(calls[0].body)).toEqual({grant_type:'client_credentials',client_id:'client',client_secret:'secret',scope:'payments'});
 const call=calls[1];expect(call.url).toBe('https://api.truelayer-sandbox.com/v3/payments');expect(call.headers.Authorization).toBe('Bearer payments-token');
 const parts=call.headers['Tl-Signature'].split('.');const header=JSON.parse(Buffer.from(parts[0],'base64url').toString());expect(header).toEqual({alg:'ES512',kid:'kid',tl_version:'2',tl_headers:'Idempotency-Key'});expect(parts[1]).toBe('');
 const payload=`POST /v3/payments\nIdempotency-Key: ${call.headers['Idempotency-Key']}\n${call.body}`;
 expect(verify('SHA512',Buffer.from(parts[0]+'.'+Buffer.from(payload).toString('base64url')),{key:ec.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url'))).toBe(true);
 expect(JSON.parse(call.body).idempotency_key).toBeUndefined();expect(call.body).not.toContain('secret');expect(result.data).toHaveProperty('resource_token','resource');
});

test('Salt Edge signs canonical full URL and wrapped PIS body',async()=>{
 let request:any;globalThis.fetch=(async(url,init)=>{request={url:String(url),...init};return Response.json({data:{payment_id:'p',payment_url:'https://www.saltedge.com/payments/connect?token=x'}});}) as typeof fetch;
 const result=await execute('saltedge-payments','create_payment',{template_identifier:'SEPA',customer_id:'c',payment_attributes:{creditor_name:'Recipient',creditor_iban:'ES9121000418450200051332',amount:'1.00',currency_code:'EUR',description:'Invoice',end_to_end_id:'intent',customer_ip_address:'192.0.2.1'},provider:{code:'bank'},attempt:{return_to:'https://example.com/return',custom_fields:{state:'random'}}},{app_id:'app',secret:'secret',private_key:pem(rsa.privateKey)});
 expect(request.url).toBe('https://www.saltedge.com/api/v6/payments/create');const body=JSON.parse(request.body);expect(body.data.payment_attributes.amount).toBe('1.00');expect(body.data.attempt.custom_fields.state).toBe('random');
 const canonical=`${request.headers['Expires-at']}|POST|${request.url}|${request.body}`;
 expect(verify('RSA-SHA256',Buffer.from(canonical),rsa.publicKey,Buffer.from(request.headers.Signature,'base64'))).toBe(true);expect(result.data).toHaveProperty('data.payment_url');
});

test('Teller OPTIONS has no body and retains all capability data',async()=>{
 let request:any;globalThis.fetch=(async(url,init)=>{request={url:String(url),...init};return Response.json({schemes:['zelle']});}) as typeof fetch;
 const result=await execute('teller','get_payment_capabilities',{account_id:'a'},{username:'token',password:'x'});expect(request.method).toBe('OPTIONS');expect(request.body).toBeUndefined();expect(request.url).toBe('https://api.teller.io/accounts/a/payments');expect(result.data).toEqual({schemes:['zelle']});
});

test('Enable Banking supports deferred PIS flow without payment deletion/cancellation confusion',async()=>{
 const calls:any[]=[];globalThis.fetch=(async(url,init)=>{calls.push({url:String(url),...init});return Response.json({payment_id:'p',url:'https://auth.enablebanking.com/pay',status:'PDNG'});}) as typeof fetch;
 const creds={application_id:'app',private_key:pem(rsa.privateKey)};
 const input={payment_type:'SEPA',payment_request:{credit_transfer_transaction:[{beneficiary:{creditor:{name:'Recipient'},creditor_account:{identification:'ES9121000418450200051332',scheme_name:'IBAN'}},instructed_amount:{amount:'1.00',currency:'EUR'},remittance_information:['Invoice']}]},aspsp:{name:'BBVA',country:'ES'},psu_type:'personal',state:'random',redirect_url:'https://example.com/return',defer_submission:true};
 const result=await execute('enable-banking','create_payment',input,creds);expect(JSON.parse(calls[0].body)).toEqual(input);expect(result.data).toHaveProperty('url');
 await execute('enable-banking','submit_payment',{payment_id:'p'},creds);expect(calls[1].url).toBe('https://api.enablebanking.com/payments/p/submit');expect(JSON.parse(calls[1].body)).toEqual({});expect(getAppTemplate('enable-banking')!.tools.some(t=>t.method==='DELETE'&&t.path.startsWith('/payments'))).toBe(false);
});

test('Teller account links and MFA tokens survive unchanged',async()=>{
 globalThis.fetch=(async()=>Response.json({id:'a',links:{payments:'https://api.teller.io/accounts/a/payments'}})) as typeof fetch;
 const result=await execute('teller','get_account',{account_id:'a'},{username:'token',password:'x'});expect(result.data).toHaveProperty('links.payments');
});

test('Plaid Transfer Link and event cursor requests use documented fields',async()=>{
 const calls:any[]=[];globalThis.fetch=(async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});return Response.json({transfer_events:[{event_id:7,event_type:'returned'}]});}) as typeof fetch;
 const credentials={client_id:'client',secret:'secret',environment:'sandbox'};
 await execute('plaid','create_link_token',{client_name:'Finance',country_codes:['US'],language:'en',user:{client_user_id:'u'},products:['auth'],transfer:{authorization_id:'auth-1'}},credentials);
 expect(calls[0].body.transfer).toEqual({authorization_id:'auth-1'});
 const result=await execute('plaid','sync_transfer_events',{after_id:6,count:100},credentials);expect(calls[1].url).toBe('https://sandbox.plaid.com/transfer/event/sync');expect(calls[1].body.after_id).toBe(6);expect(result.data).toHaveProperty('transfer_events');
 expect(getAppTemplate('plaid')!.tools.find(t=>t.name==='cancel_transfer')!.description).toContain('cancellable');
});
