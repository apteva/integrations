import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import { getAppTemplate } from '../src/apps/index.js';
import { executeTool } from '../src/http-executor.js';
import type { AppTemplate, AppToolTemplate } from '../src/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const slugs = ['openligadb','opendota','squiggle','jolpica-f1','openf1','college-football-data','the-racing-api','sportsgameodds','football-data-org','cricketdata','balldontlie','sportmonks-football','pandascore','sharpapi','odds-api-io','betfair-exchange','datagolf','api-tennis','sportradar'];
function app(slug: string): AppTemplate {
 const value=getAppTemplate(slug);
 if(!value) throw new Error(`Missing sports integration ${slug}`);
 return value;
}
function tool(slug:string,name:string):AppToolTemplate {
 const value=app(slug).tools.find(t=>t.name===name);
 if(!value)throw new Error(`Missing ${slug}.${name}`);
 return value;
}
async function record(slug:string,name:string,input:Record<string,unknown>,credentials:any={},response:any={data:[]}) {
 let captured:{url:URL;init:RequestInit}|undefined;
 globalThis.fetch=(async (url,init)=>{
  captured={url:new URL(String(url)),init:init||{}};
  return Response.json(response);
 }) as typeof fetch;
 // Pacing is covered by executor tests; these tests focus on provider contracts.
 const result=await executeTool({app:app(slug),tool:{...tool(slug,name),rate_limit:undefined},input,credentials});
 if(!captured)throw new Error(`No request for ${slug}.${name}`);
 return {...captured,headers:new Headers(captured.init.headers),result};
}

describe('documented sports API catalogs',()=>{
 test('discovers all providers, valid input paths, and usable health checks',()=>{
  for(const slug of slugs){
   const a=app(slug);
   expect(a.tools.length).toBeGreaterThan(0);
   expect(new Set(a.tools.map(t=>t.name)).size).toBe(a.tools.length);
   const credentialNames=new Set(a.auth.credential_fields?.map(f=>f.name));
   for(const t of a.tools){
    expect(['GET','POST']).toContain(t.method);
    if(t.method==='POST')expect(slug).toBe('betfair-exchange');
    expect(t.path).not.toMatch(/\.csv|\.zip|websocket|\/stream\b/i);
    const schema=t.input_schema as any;
    expect(schema.type).toBe('object');
    for(const key of schema.required||[])expect(schema.properties[key]).toBeDefined();
    for(const [,key] of t.path.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)){
     expect(schema.properties[key]).toBeDefined();
     expect(schema.required).toContain(key);
    }
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
   }
   for(const [,field] of a.base_url.matchAll(/\{\{(?:credential\.)?(\w+)\}\}/g))expect(credentialNames.has(field)).toBe(true);
   const h=a.health_check!;
   const ht=tool(slug,h.tool!);
   for(const field of (ht.input_schema.required as string[]||[]))expect(h.input?.[field]).toBeDefined();
  }
 });
 test('server ships identical copies of every sports catalog',()=>{
  for(const slug of [...slugs,'the-odds-api']){
   const source=readFileSync(new URL(`../src/apps/${slug}.json`,import.meta.url));
   const embedded=readFileSync(new URL(`../../server/integrations-catalog/${slug}.json`,import.meta.url));
   expect(embedded.equals(source)).toBe(true);
  }
 });
 test('public APIs construct provider-specific paths without auth',async()=>{
  const cases:[string,string,Record<string,unknown>,string][]=[
   ['openligadb','list_matches',{leagueShortcut:'bl1',leagueSeason:2025,groupOrderId:1},'https://api.openligadb.de/getmatchdata/bl1/2025/1'],
   ['opendota','get_player_matches',{account_id:123,limit:5,offset:10},'https://api.opendota.com/api/players/123/matches'],
   ['jolpica-f1','get_results',{season:'2025',round:'1',limit:1},'https://api.jolpi.ca/ergast/f1/2025/1/results.json'],
  ];
  for(const [slug,name,input,expected] of cases){
   const r=await record(slug,name,input,{},[]);
   expect(r.url.origin+r.url.pathname).toBe(expected);
   expect(r.headers.has('Authorization')).toBe(false);
   expect(r.result.success).toBe(true);
  }
 });
 test('Squiggle fixes the query type and sends the operator contact only in User-Agent',async()=>{
  const r=await record('squiggle','get_tips',{year:2025,round:1,source:2},{fields:{contact_email:'operator@example.com'}});
  expect(r.url.searchParams.get('q')).toBe('tips');
  expect(r.url.searchParams.get('format')).toBe('json');
  expect(r.url.searchParams.get('source')).toBe('2');
  expect(r.url.searchParams.has('contact_email')).toBe(false);
  expect(r.headers.get('User-Agent')).toContain('operator@example.com');
 });
 test('OpenF1 maps date operators and omits empty live auth',async()=>{
  const input={session_key:123,driver_number:4,date_from:'2025-03-16T04:00:00Z',date_to:'2025-03-16T04:10:00Z'};
  const r=await record('openf1','get_positions',input,{},[]);
  expect(r.url.pathname).toBe('/v1/position');
  expect(r.url.searchParams.get('date>=')).toBe(input.date_from);
  expect(r.url.searchParams.get('date<=')).toBe(input.date_to);
  expect(r.url.searchParams.has('date_from')).toBe(false);
  expect(r.headers.has('Authorization')).toBe(false);
  const live=await record('openf1','list_drivers',{session_key:123},{fields:{authorization:'Bearer sponsor-token'}},[]);
  expect(live.headers.get('Authorization')).toBe('Bearer sponsor-token');
 });
 test('sends keys in the documented header and never as query parameters',async()=>{
  const cases:[string,string,Record<string,unknown>,string,string,string][]=[
   ['football-data-org','get_standings',{competition:'PL'},'https://api.football-data.org/v4/competitions/PL/standings','X-Auth-Token','test-key'],
   ['college-football-data','get_rankings',{year:2025,week:1},'https://api.collegefootballdata.com/rankings','Authorization','Bearer test-key'],
   ['sportsgameodds','list_events',{leagueID:'NBA',cursor:'opaque+/=',oddsAvailable:true},'https://api.sportsgameodds.com/v2/events/','X-Api-Key','test-key'],
   ['sharpapi','get_odds',{league:'nba',cursor:'opaque+/=',market:'main'},'https://api.sharpapi.io/api/v1/odds','X-API-Key','test-key'],
   ['pandascore','list_upcoming_matches',{per_page:5,begin_at:'2025-01-01,2025-01-02'},'https://api.pandascore.co/matches/upcoming','Authorization','Bearer test-key'],
  ];
  for(const [slug,name,input,expected,header,value] of cases){
   const r=await record(slug,name,input,{api_key:'test-key'},{data:[],nextCursor:'next',pagination:{next_cursor:'next'}});
   expect(r.url.origin+r.url.pathname).toBe(expected);
   expect(r.headers.get(header)).toBe(value);
   expect(r.url.searchParams.has('api_key')).toBe(false);
   expect(r.url.searchParams.has('apiKey')).toBe(false);
   expect(r.result.data).toHaveProperty('nextCursor','next');
   if(input.cursor)expect(r.url.searchParams.get('cursor')).toBe(input.cursor as string);
   if(slug==='pandascore')expect(r.url.searchParams.get('range[begin_at]')).toBe(input.begin_at as string);
  }
 });
 test('BALLDONTLIE serializes arrays with repeated bracketed keys',async()=>{
  const r=await record('balldontlie','list_games',{dates:['2025-01-01','2025-01-02'],team_ids:[1,2],seasons:[2024],cursor:99},{api_key:'bdl-key'},{data:[],meta:{next_cursor:100}});
  expect(r.url.pathname).toBe('/v1/games');
  expect(r.headers.get('Authorization')).toBe('bdl-key');
  expect(r.url.searchParams.getAll('dates[]')).toEqual(['2025-01-01','2025-01-02']);
  expect(r.url.searchParams.getAll('team_ids[]')).toEqual(['1','2']);
  expect(r.url.searchParams.has('dates')).toBe(false);
  expect(r.result.data).toHaveProperty('meta.next_cursor',100);
  const odds=await record('balldontlie','get_odds',{game_ids:[123]},{api_key:'bdl-key'});
  expect(odds.url.pathname).toBe('/v2/odds');
 });
 test('Sportmonks and Odds-API.io use their distinct query-key contracts',async()=>{
  const sm=await record('sportmonks-football','get_fixture',{fixture_id:123,include:'scores;participants'},{api_key:'sm-key'});
  expect(sm.url.pathname).toBe('/v3/football/fixtures/123');
  expect(sm.url.searchParams.get('api_token')).toBe('sm-key');
  expect(sm.url.searchParams.get('include')).toBe('scores;participants');
  const odds=await record('odds-api-io','get_odds',{eventId:'123',bookmakers:'Bet365,Unibet'},{api_key:'oi-key'});
  expect(odds.url.pathname).toBe('/v3/odds');
  expect(odds.url.searchParams.get('apiKey')).toBe('oi-key');
  expect(odds.url.searchParams.get('bookmakers')).toBe('Bet365,Unibet');
  expect((tool('odds-api-io','get_odds').input_schema as any).required).toContain('bookmakers');
 });
 test('CricketData preserves quota metadata, strips its echoed key and rejects HTTP-200 API failures',async()=>{
  const r=await record('cricketdata','get_match',{id:'match-uuid'},{api_key:'cricket-key'},{status:'success',apikey:'cricket-key',data:{id:'match-uuid'},info:{hitsToday:1}});
  expect(r.url.pathname).toBe('/v1/match_info');
  expect(r.url.searchParams.get('apikey')).toBe('cricket-key');
  expect(r.result.success).toBe(true);
  expect(r.result.data).toHaveProperty('info.hitsToday',1);
  expect(r.result.data).not.toHaveProperty('apikey');
  const bad=await record('cricketdata','get_match',{id:'match-uuid'},{api_key:'test-key'},{status:'failure',reason:'Quota exceeded',apikey:'test-key'});
  expect(bad.result.success).toBe(false);
  expect(bad.result.data).not.toHaveProperty('provider_error.apikey');
 });
 test('API Tennis keeps fixed methods, credential casing and provider error semantics',async()=>{
  const r=await record('api-tennis','get_head_to_head',{first_player_key:30,second_player_key:5},{api_key:'tennis-key'},{success:1,result:{H2H:[]}});
  expect(r.url.pathname).toBe('/tennis/');
  expect(r.url.searchParams.get('method')).toBe('get_H2H');
  expect(r.url.searchParams.get('APIkey')).toBe('tennis-key');
  expect(r.result.success).toBe(true);
  const bad=await record('api-tennis','list_event_types',{}, {api_key:'test-key'},{success:0,error:'Invalid key'});
  expect(bad.result.success).toBe(false);
 });
 test('response omissions apply after extraction and traverse nested arrays',async()=>{
  globalThis.fetch=(async()=>Response.json({data:{groups:[{items:[{value:1,secret:'hidden'}]}],keep:true}})) as typeof fetch;
  const result=await executeTool({app:app('cricketdata'),tool:{...tool('cricketdata','get_match'),rate_limit:undefined,response_error:undefined,response_path:'data',response_omit:['groups[].items[].secret','absent.child']},input:{id:'match-uuid'},credentials:{api_key:'test-key'}});
  expect(result.data).toEqual({groups:[{items:[{value:1}]}],keep:true});
 });
 test('CricketData omits echoed keys on HTTP failures too',async()=>{
  globalThis.fetch=(async()=>Response.json({apikey:'test-key',reason:'expired key'},{status:401})) as typeof fetch;
  const result=await executeTool({app:app('cricketdata'),tool:{...tool('cricketdata','get_match'),rate_limit:undefined},input:{id:'match-uuid'},credentials:{api_key:'test-key'}});
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.data)).not.toContain('test-key');
  expect(JSON.stringify(result.data)).toContain('expired key');
 });
 test('Data Golf forces JSON while preserving key and market filters',async()=>{
  const r=await record('datagolf','get_outright_odds',{tour:'pga',market:'win',odds_format:'decimal'},{api_key:'dg-key'});
  expect(r.url.origin+r.url.pathname).toBe('https://feeds.datagolf.com/betting-tools/outrights');
  expect(r.url.searchParams.get('file_format')).toBe('json');
  expect(r.url.searchParams.get('market')).toBe('win');
  expect(r.url.searchParams.get('key')).toBe('dg-key');
 });
 test('The Racing API uses Basic auth and unbracketed repeated region codes',async()=>{
  const r=await record('the-racing-api','get_free_racecards',{day:'tomorrow',region_codes:['gb','ire'],limit:5},{fields:{username:'race-user',password:'race-pass'}});
  expect(r.url.pathname).toBe('/v1/racecards/free');
  expect(r.headers.get('Authorization')).toBe('Basic '+Buffer.from('race-user:race-pass').toString('base64'));
  expect(r.url.searchParams.getAll('region_codes')).toEqual(['gb','ire']);
  expect(r.url.searchParams.has('username')).toBe(false);
 });
 test('Betfair sends nested filters and price projections as read-only POST bodies',async()=>{
  const credentials={fields:{app_key:'application-key',session_token:'session-token'}};
  const input={filter:{eventTypeIds:['1'],marketStartTime:{from:'2025-01-01T00:00:00Z'}},maxResults:'10',marketProjection:['RUNNER_DESCRIPTION']};
  const r=await record('betfair-exchange','list_market_catalogue',input,credentials,[]);
  expect(r.url.href).toBe('https://api.betfair.com/exchange/betting/rest/v1.0/listMarketCatalogue/');
  expect(r.init.method).toBe('POST');
  expect(JSON.parse(String(r.init.body))).toEqual(input);
  expect(r.headers.get('X-Application')).toBe('application-key');
  expect(r.headers.get('X-Authentication')).toBe('session-token');
  const b=await record('betfair-exchange','get_market_book',{marketIds:['1.234'],priceProjection:{priceData:['EX_BEST_OFFERS']}},credentials,[]);
  expect(JSON.parse(String(b.init.body)).priceProjection.priceData).toEqual(['EX_BEST_OFFERS']);
 });
 test('Sportradar defaults to trial English Soccer v4 and supports production credentials',async()=>{
  const r=await record('sportradar','list_competitions',{}, {api_key:'sr-key'});
  expect(r.url.href).toBe('https://api.sportradar.com/soccer/trial/v4/en/competitions.json');
  expect(r.headers.get('x-api-key')).toBe('sr-key');
  const summary=tool('sportradar','get_event_summary');
  const fields=Object.keys(summary.input_schema.properties as object);
  const idField=fields.find(f=>f.includes('event'))!;
  const p=await record('sportradar','get_event_summary',{[idField]:'sr:sport_event:123'},{api_key:'sr-key',fields:{access_level:'production',language:'es'}});
  expect(p.url.pathname).toBe('/soccer/production/v4/es/sport_events/sr%3Asport_event%3A123/summary.json');
  expect(p.url.searchParams.has(idField)).toBe(false);
 });
});
