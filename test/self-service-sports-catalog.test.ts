import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import { getAppTemplate } from '../src/apps/index.js';
import { executeTool } from '../src/http-executor.js';
import type { AppTemplate } from '../src/types.js';

const sports = ['basketball', 'baseball', 'hockey', 'rugby', 'mma', 'formula-1', 'american-football'];
const slugs = ['mlb-stats', 'nhl', 'chess-com', 'matchbook', 'sharpsports', ...sports.map(s => `api-sports-${s}`)];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function app(slug: string): AppTemplate {
  const value = getAppTemplate(slug);
  if (!value) throw new Error(`Missing ${slug}`);
  return value;
}
function tool(slug: string, name: string) {
  const value = app(slug).tools.find(t => t.name === name);
  if (!value) throw new Error(`Missing ${slug}.${name}`);
  return value;
}
async function record(slug: string, name: string, input: Record<string, unknown>, credentials: any = {}, response: any = {}) {
  let captured: { url: URL; init: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    captured = { url: new URL(String(url)), init: init || {} };
    return Response.json(response);
  }) as typeof fetch;
  const result = await executeTool({ app: app(slug), tool: { ...tool(slug, name), rate_limit: undefined }, input, credentials });
  if (!captured) throw new Error('No HTTP request');
  return { ...captured, headers: new Headers(captured.init.headers), result };
}

describe('self-service sports and betting APIs', () => {
  test('all additions are discoverable, have complete path inputs and identical server copies', () => {
    for (const slug of [...slugs, 'api-sports']) {
      const a = app(slug);
      expect(a.tools.length).toBeGreaterThan(0);
      expect(new Set(a.tools.map(t => t.name)).size).toBe(a.tools.length);
      for (const t of a.tools) {
        const s = t.input_schema as any;
        expect(s.type).toBe('object');
        expect(JSON.stringify(s)).not.toContain('"$ref"');
        for (const key of s.required || []) expect(s.properties[key]).toBeDefined();
        for (const [, key] of t.path.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)) {
          expect(s.properties[key]).toBeDefined();
          expect(s.required).toContain(key);
        }
      }
      const probe = a.health_check!;
      for (const key of tool(slug, probe.tool!).input_schema.required as string[] || []) expect(probe.input?.[key]).toBeDefined();
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url));
      expect(readFileSync(new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url)).equals(source)).toBe(true);
    }
  });
  test('public APIs use no authentication and preserve game and pagination metadata', async () => {
    const cases: [string, string, Record<string, unknown>, string][] = [
      ['mlb-stats', 'get_schedule', { sportId: 1, startDate: '2025-09-01', endDate: '2025-09-03', teamId: 147 }, 'https://statsapi.mlb.com/api/v1/schedule'],
      ['mlb-stats', 'get_game_feed', { gamePk: 777001 }, 'https://statsapi.mlb.com/api/v1.1/game/777001/feed/live'],
      ['nhl', 'get_team_schedule', { team: 'TOR', season: '20252026' }, 'https://api-web.nhle.com/v1/club-schedule-season/TOR/20252026'],
      ['nhl', 'get_game_play_by_play', { gameId: 2025020001 }, 'https://api-web.nhle.com/v1/gamecenter/2025020001/play-by-play'],
      ['chess-com', 'get_monthly_games', { username: 'erik', year: '2025', month: '01' }, 'https://api.chess.com/pub/player/erik/games/2025/01'],
    ];
    for (const [slug, name, input, expected] of cases) {
      const r = await record(slug, name, input, {}, { games: [], copyright: 'provider terms', nextDate: '2025-09-04' });
      expect(r.url.origin + r.url.pathname).toBe(expected);
      expect(r.headers.has('Authorization')).toBe(false);
      expect(r.init.method).toBe('GET');
      expect(r.result.data).toHaveProperty('copyright');
      expect(r.result.data).toHaveProperty('nextDate');
      if (name === 'get_schedule') expect(r.url.searchParams.get('teamId')).toBe('147');
      if ('gamePk' in input) expect(r.url.searchParams.has('gamePk')).toBe(false);
    }
    expect((tool('chess-com', 'get_monthly_games').input_schema as any).properties.month.pattern).toBe('^(0[1-9]|1[0-2])$');
  });
  test('API-Sports uses seven fixed sport hosts with key headers and quota health checks', async () => {
    for (const sport of sports) {
      const slug = `api-sports-${sport}`;
      const r = await record(slug, 'status', {}, { api_key: 'test-key' }, { response: { subscription: { active: true }, requests: { current: 12, limit_day: 100 } }, errors: [] });
      expect(r.url.href).toBe(`https://v1.${sport}.api-sports.io/status`);
      expect(r.headers.get('x-apisports-key')).toBe('test-key');
      expect(r.url.searchParams.has('api_key')).toBe(false);
      expect(r.result.success).toBe(true);
      expect(r.result.data).toHaveProperty('response.requests.limit_day', 100);
      const bad = await record(slug, 'status', {}, { api_key: 'expired-key' }, { errors: { token: 'Invalid key' }, response: [] });
      expect(bad.result.success).toBe(false);
    }
  });
  test('sport-specific statistics and bookmaker paths are not football clones', async () => {
    const cases: [string, string, Record<string, unknown>, string][] = [
      ['basketball', 'get_team_statistics', { league: 12, season: '2025-2026', team: 1 }, '/statistics'],
      ['baseball', 'get_team_statistics', { league: 1, season: '2025', team: 1 }, '/teams/statistics'],
      ['hockey', 'get_game_events', { game: 42 }, '/games/events'],
      ['rugby', 'get_head_to_head', { h2h: '1-2', season: 2025 }, '/games/h2h'],
      ['mma', 'get_fight_results', { ids: '865-878' }, '/fights/results'],
      ['formula-1', 'get_race_rankings', { race: 42 }, '/rankings/races'],
      ['american-football', 'get_game_events', { id: 42 }, '/games/events'],
    ];
    for (const [sport, name, input, expected] of cases) {
      const r = await record(`api-sports-${sport}`, name, input, { api_key: 'test-key' }, { response: [], errors: [] });
      expect(r.url.pathname).toBe(expected);
      for (const [key, value] of Object.entries(input)) expect(r.url.searchParams.get(key)).toBe(String(value));
    }
    expect(tool('api-sports-basketball', 'list_bookmakers').path).toBe('/bookmakers');
    expect(tool('api-sports-baseball', 'list_bookmakers').path).toBe('/odds/bookmakers');
    expect((tool('api-sports-american-football', 'get_odds').input_schema as any).required).toContain('game');
  });
  test('Matchbook uses session headers and actual nested offer arrays, preserving per-offer failures', async () => {
    const input = { 'odds-type': 'DECIMAL', 'exchange-type': 'back-lay', offers: [{ 'runner-id': 401525949430009, side: 'back', odds: 2.4, stake: 5, 'keep-in-play': true }] };
    const response = { offers: [{ id: 12, status: 'failed', errors: ['Insufficient balance'] }, { id: 13, status: 'open', remaining: 5 }] };
    const r = await record('matchbook', 'submit_offers', input, { fields: { session_token: 'session-secret' } }, response);
    expect(r.url.href).toBe('https://api.matchbook.com/edge/rest/v2/offers');
    expect(r.headers.get('session-token')).toBe('session-secret');
    expect(r.headers.get('Content-Type')).toContain('application/json');
    expect(JSON.parse(String(r.init.body))).toEqual(input);
    expect(r.result.data).toEqual(response);
    const edit = { offers: [{ id: 13, 'current-odds': 2.4, 'new-odds': 2.5, 'current-stake': 5, 'new-stake': 6.5 }] };
    const e = await record('matchbook', 'edit_offers', edit, { fields: { session_token: 'session-secret' } });
    expect(e.init.method).toBe('PUT');
    expect(JSON.parse(String(e.init.body))).toEqual(edit);
    const c = await record('matchbook', 'cancel_offer', { offer_id: 13 }, { fields: { session_token: 'session-secret' } }, { id: 13, status: 'cancelled' });
    expect(c.init.method).toBe('DELETE');
    expect(c.url.href).toBe('https://api.matchbook.com/edge/rest/v2/offers/13');
    expect(c.result.data).toHaveProperty('status', 'cancelled');
  });
  test('Matchbook never automatically retries an ambiguous submission', async () => {
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return Response.json({ errors: ['rate limit'] }, { status: 429 }); }) as typeof fetch;
    const result = await executeTool({ app: app('matchbook'), tool: tool('matchbook', 'submit_offers'), input: { 'odds-type': 'DECIMAL', offers: [{ 'runner-id': 1, side: 'back', odds: 2, stake: 1 }] }, credentials: { fields: { session_token: 'test' } } });
    expect(result.success).toBe(false);
    expect(requests).toBe(1);
    for (const name of ['submit_offers', 'edit_offers', 'cancel_offer']) expect(tool('matchbook', name).rate_limit?.max_retries).toBe(0);
  });
  test('Matchbook exposes prices and pagination plus offer and settlement reads', async () => {
    const r = await record('matchbook', 'list_events', { 'sport-ids': '15', 'include-prices': true, offset: '20', 'per-page': '10' }, { fields: { session_token: 'test' } }, { events: [], total: 30 });
    expect(r.url.searchParams.get('sport-ids')).toBe('15');
    expect(r.url.searchParams.get('include-prices')).toBe('true');
    expect(r.url.searchParams.get('per-page')).toBe('10');
    expect(r.result.data).toHaveProperty('total', 30);
    expect(tool('matchbook', 'get_offer').path).toBe('/edge/rest/v2/offers/{offer_id}');
    expect(tool('matchbook', 'list_settled_bets').path).toBe('/edge/rest/reports/v2/bets/settled');
  });
  test('SharpSports distinguishes public and private keys on the same sandbox/live host', async () => {
    const credentials = { fields: { public_key: 'public_sandbox_test', private_key: 'private_sandbox_test' } };
    const pub = await record('sharpsports', 'list_books', { support: 'betsync' }, credentials);
    expect(pub.headers.get('Authorization')).toBe('Token public_sandbox_test');
    const priv = await record('sharpsports', 'list_bet_slips_by_bettor', { id: 'BETT_123', pageSize: 25, pageNum: 2, status: 'pending' }, credentials, { betSlips: [], next: 'next-page' });
    expect(priv.url.pathname).toBe('/v1/bettors/BETT_123/betSlips');
    expect(priv.url.searchParams.get('pageNum')).toBe('2');
    expect(priv.headers.get('Authorization')).toBe('Token private_sandbox_test');
    expect(priv.result.data).toHaveProperty('next', 'next-page');
    expect(priv.url.searchParams.has('private_key')).toBe(false);
  });
  test('SharpSports contexts carry stable user IDs and selections without executing a sportsbook bet', async () => {
    const credentials = { fields: { public_key: 'pub-test', private_key: 'private-test' } };
    const input = { internalId: 'user_123', marketSelection: 'MSEL_123', bookAbbr: 'dk', line: 2.5 };
    const r = await record('sharpsports', 'create_bet_place_context', input, credentials, { cid: 'CTX_test' });
    expect(r.url.href).toBe('https://api.sharpsports.io/v1/context/selection');
    expect(r.init.method).toBe('POST');
    expect(r.headers.get('Authorization')).toBe('Token pub-test');
    expect(JSON.parse(String(r.init.body))).toEqual(input);
    expect(r.result.data).toHaveProperty('cid', 'CTX_test');
    expect(tool('sharpsports', 'create_bet_place_context').description).toContain('does not execute a wager');
    const link = await record('sharpsports', 'create_link_context', { internalId: 'user_123', redirectUrl: 'https://example.com/linked' }, credentials, { cid: 'CTX_link' });
    expect(link.url.pathname).toBe('/v1/context');
    expect(JSON.parse(String(link.init.body)).internalId).toBe('user_123');
    expect(tool('sharpsports', 'refresh_bettor').rate_limit?.min_interval_ms).toBe(60000);
  });
});
