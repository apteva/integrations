import {createPrivateKey,createSign} from 'node:crypto';

export function signPaymentRequest(name:string,method:string,url:string,body:string,headers:Record<string,string>,credentials:Record<string,string>):void {
 const pem=(credentials.private_key||'').trim().replace(/\\r\\n|\\n|\\r/g,'\n');
 const key=createPrivateKey(pem);
 if(name==='saltedge_pis') {
  if(key.asymmetricKeyType!=='rsa')throw new Error('Salt Edge PIS requires an RSA private key');
  const expires=String(Math.floor(Date.now()/1000)+60);
  headers['Expires-at']=expires;
  headers.Signature=createSign('RSA-SHA256').update(`${expires}|${method}|${url}|${body}`).end().sign(key).toString('base64');
  return;
 }
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='secp521r1')throw new Error('TrueLayer Payments requires an EC P-521 private key');
 const kid=credentials.signing_key_id;
 const idempotency=Object.entries(headers).find(([k])=>k.toLowerCase()==='idempotency-key')?.[1];
 if(!kid||!idempotency)throw new Error('TrueLayer Payments requires signing_key_id and idempotency_key');
 const protectedHeader=Buffer.from(JSON.stringify({alg:'ES512',kid,tl_version:'2',tl_headers:'Idempotency-Key'})).toString('base64url');
 const path=new URL(url).pathname.replace(/\/$/,'');
 const payload=`${method} ${path}\nIdempotency-Key: ${idempotency}\n${body}`;
 const input=`${protectedHeader}.${Buffer.from(payload).toString('base64url')}`;
 const signature=createSign('SHA512').update(input).end().sign({key,dsaEncoding:'ieee-p1363'}).toString('base64url');
 headers['Tl-Signature']=`${protectedHeader}..${signature}`;
}
