import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import { getAppTemplate } from '../src/apps/index.js';
import { executeTool } from '../src/http-executor.js';
import { generateMcpServer } from '../src/mcp-generator.js';
import type { AppTemplate, Connection } from '../src/types.js';

// Contracts checked against the provider docs on 2026-10-01:
// https://replicate.com/humbleworth/price-predict-v1/api
// https://documenter.getpostman.com/view/11906748/2sBXwqrqM2
// https://github.com/domainret/estibot-api
// https://domainindex.com/api
// https://www.atom.com/atom-mcp-server/docs
// https://www.atom.com/.well-known/oauth-authorization-server
const slugs = ['replicate', 'bishopi', 'estibot', 'domainindex', 'atom'];
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
async function record(slug: string, name: string, input: Record<string, unknown>, response: unknown = {}, status = 200) {
  let captured: { url: URL; init: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    captured = { url: new URL(String(url)), init: init || {} };
    return Response.json(response, { status });
  }) as typeof fetch;
  const result = await executeTool({
    app: app(slug), tool: { ...tool(slug, name), rate_limit: undefined }, input,
    credentials: { fields: { api_key: 'test-api-key', token: 'test-replicate-token' } },
  });
  if (!captured) throw new Error('No request');
  return { ...captured, headers: new Headers(captured.init.headers), result };
}

describe('domain appraisal integrations', () => {
  test('all entries load, have complete schemas and identical embedded server copies', () => {
    for (const slug of slugs) {
      const a = app(slug);
      expect(a.categories).toContain('domain-appraisal');
      expect(a.auth.credential_fields?.length).toBeGreaterThan(0);
      for (const t of a.tools) {
        const s = t.input_schema as any;
        expect(s.type).toBe('object');
        for (const key of s.required || []) expect(s.properties[key]).toBeDefined();
        for (const [, key] of t.path.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)) {
          expect(s.properties[key]).toBeDefined();
          expect(s.required).toContain(key);
        }
      }
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url));
      expect(readFileSync(new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url)).equals(source)).toBe(true);
    }
    expect(getAppTemplate('humbleworth')).toBeUndefined();
    expect(existsSync(new URL('../src/apps/humbleworth.json', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../server/integrations-catalog/humbleworth.json', import.meta.url))).toBe(false);
    // No billable appraisal is used as a connection health probe.
    expect(app('replicate').health_check?.tool).toBe('get_account');
    for (const slug of ['bishopi', 'estibot', 'domainindex']) expect(app(slug).health_check).toBeUndefined();
  });

  test('HumbleWorth wraps flat domains in Replicate input and pins the published model version', async () => {
    const response = { id: 'prediction-123', status: 'starting', output: null, error: null };
    const r = await record('replicate', 'appraise_domains', {
      domains: 'example.com,startup.net', webhook: 'https://example.org/callback', webhook_events_filter: ['completed'],
    }, response);
    expect(r.url.href).toBe('https://api.replicate.com/v1/predictions');
    expect(r.init.method).toBe('POST');
    expect(r.headers.get('Authorization')).toBe('Bearer test-replicate-token');
    expect(JSON.parse(String(r.init.body))).toEqual({
      version: 'a925db842c707850e4ca7b7e86b217692b0353a9ca05eb028802c4a85db93843',
      input: { domains: 'example.com,startup.net' },
      webhook: 'https://example.org/callback', webhook_events_filter: ['completed'],
    });
    expect(r.result.data).toEqual(response);
    const minimum = await record('replicate', 'appraise_domains', { domains: 'example.com' });
    expect(JSON.parse(String(minimum.init.body))).not.toHaveProperty('webhook');
    const generated = generateMcpServer({ id: 'test', credentials: { token: 'test' } } as Connection, app('replicate'));
    expect(generated.tools.find(t => t.name === 'replicate_appraise_domains')?.http_config.request_transform).toEqual(tool('replicate', 'appraise_domains').request_transform);
  });

  test('HumbleWorth preserves completion, output errors and valuation categories when polling', async () => {
    const response = { id: 'prediction-123', status: 'succeeded', error: null, output: { valuations: [{ domain: 'example.com', auction: 50, marketplace: 500, brokerage: 1000 }] } };
    const r = await record('replicate', 'get_prediction', { prediction_id: 'prediction-123' }, response);
    expect(r.url.href).toBe('https://api.replicate.com/v1/predictions/prediction-123');
    expect(r.result.data).toEqual(response);
    const failed = await record('replicate', 'get_prediction', { prediction_id: 'prediction-123' }, { status: 'failed', error: 'Model error' });
    expect(failed.result.data).toEqual({ status: 'failed', error: 'Model error' });
    const cancel = await record('replicate', 'cancel_prediction', { prediction_id: 'prediction-123' });
    expect(cancel.url.href).toBe('https://api.replicate.com/v1/predictions/prediction-123/cancel');
    expect(cancel.init.method).toBe('POST');
    expect(JSON.parse(String(cancel.init.body))).toEqual({});
  });

  test('paid prediction submissions are not retried after ambiguous failures', async () => {
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return Response.json({ detail: 'Throttled' }, { status: 429 }); }) as typeof fetch;
    const result = await executeTool({ app: app('replicate'), tool: tool('replicate', 'appraise_domains'), input: { domains: 'example.com' }, credentials: { token: 'test' } });
    expect(result.success).toBe(false);
    expect(requests).toBe(1);
  });

  test('Bishopi uses the documented Api-Key header and valuation route, preserving confidence/comps', async () => {
    const response = { domain: 'example.com', estimate: { p10: 100, p50: 500 }, confidence: 0.7, comp_count: 10, comparables: [{ domain: 'sample.com', price: 500 }] };
    const r = await record('bishopi', 'appraise_domain', { domain: 'example.com' }, response);
    expect(r.url.href).toBe('https://api.bishopi.io/sales/valuation/?domain=example.com');
    expect(r.headers.get('Authorization')).toBe('Api-Key test-api-key');
    expect(r.url.searchParams.has('api_key')).toBe(false);
    expect(r.init.body).toBeUndefined();
    expect(r.result.data).toEqual(response);
    const similar = await record('bishopi', 'get_similar_sales', { domain: 'example.com', limit: 20, tld: 'com,io', price_min: 50 });
    expect(similar.url.pathname).toBe('/sales/similar/');
    expect(similar.url.searchParams.get('tld')).toBe('com,io');
    const search = await record('bishopi', 'search_sales', { search: 'ai', page: 2 }, { count: 30, next: 'page3', results: [] });
    expect(search.result.data).toHaveProperty('next', 'page3');
    expect(search.url.searchParams.get('page')).toBe('2');
    const s = tool('bishopi', 'search_sales').input_schema as any;
    expect(s.anyOf).toContainEqual({ required: ['semantic'] });
    expect(s.not).toEqual({ required: ['semantic', 'sort'] });
  });

  test('EstiBot uses current host and exact query names, preserving cache misses', async () => {
    const response = { success: true, message: '', results: [], cache: true, not_found: ['startup.net'], bulk: true };
    const r = await record('estibot', 'appraise_domains', { domains: 'example.com>>startup.net', mode: 'cache' }, response);
    expect(r.url.origin + r.url.pathname).toBe('https://public-api.estibot.com/api');
    expect(Object.fromEntries(r.url.searchParams)).toEqual({ a: 'appraise', t: 'cache', k: 'test-api-key', d: 'example.com>>startup.net' });
    expect(r.result.success).toBe(true);
    expect(r.result.data).toEqual(response);
    const live = await record('estibot', 'appraise_domains', { domains: 'example.com>>startup.net', mode: 'live' }, response);
    expect(live.url.searchParams.get('t')).toBe('live');
    const single = await record('estibot', 'appraise_domain', { domain: 'example.com', mode: 'auto' }, response);
    expect(single.url.searchParams.get('d')).toBe('example.com');
    expect(single.url.searchParams.get('t')).toBe('auto');
    expect(single.url.searchParams.has('domain')).toBe(false);
    expect((tool('estibot', 'appraise_domains').input_schema as any).properties.mode.enum).toEqual(['cache', 'live']);
  });

  test('EstiBot treats success:false inside HTTP 200 as a provider failure', async () => {
    const r = await record('estibot', 'appraise_domain', { domain: 'example.com' }, { success: false, message: 'Invalid API key.', results: [] });
    expect(r.result.success).toBe(false);
    expect(r.result.data).toHaveProperty('message', 'Invalid API key.');
  });

  test('DomainIndex sends domain batches, key and mode=json without altering domain-keyed results', async () => {
    const response = { 'example.com': { price: 1000, appraisal_permalink: 'https://domainindex.com/domains/example.com' } };
    for (const [name, action] of [['appraise_domains', 'appraise'], ['get_domain_prices', 'price'], ['get_search_metrics', 'searches'], ['detect_keywords', 'keyword_detection'], ['get_whois', 'whois'], ['check_availability', 'domain_availability']]) {
      const r = await record('domainindex', name, { domains: 'example.com,startup.net' }, response);
      expect(r.url.origin + r.url.pathname).toBe('https://domainindex.com/api.php');
      expect(Object.fromEntries(r.url.searchParams)).toEqual({ action, mode: 'json', key: 'test-api-key', domain: 'example.com,startup.net' });
      expect(r.headers.has('Authorization')).toBe(false);
      expect(r.result.data).toEqual(response);
    }
  });

  test('Atom proxies the official MCP endpoint with an OAuth token and requests read scopes', () => {
    const a = app('atom');
    const result = generateMcpServer({ id: 'test', credentials: { access_token: 'atom-token' } } as Connection, a);
    expect(result.type).toBe('remote');
    expect(result.remote).toEqual({ transport: 'http', url: 'https://mcp.atom.com/mcp', headers: { Authorization: 'Bearer atom-token' } });
    expect(result.tools).toEqual([]);
    expect(a.auth.oauth2).toMatchObject({
      authorize_url: 'https://www.atom.com/oauth/authorize', token_url: 'https://www.atom.com/oauth/token',
      pkce: true, client_id_required: true, client_secret_required: false,
      scopes: ['domains:read', 'offline_access'], extra_authorize_params: { resource: 'https://mcp.atom.com/mcp' },
    });
    expect(a.auth.oauth2?.scopes).not.toContain('domains:register');
    expect(a.auth.oauth2?.setup_steps?.join(' ')).toContain('https://www.atom.com/oauth/register');
  });

  test('batch schemas respect provider separators and documented limits', () => {
    for (const [slug, name, separator, maximum] of [['replicate', 'appraise_domains', ',', 2560], ['domainindex', 'appraise_domains', ',', 1000], ['estibot', 'appraise_domains', '>>', 200]] as const) {
      const pattern = new RegExp((tool(slug, name).input_schema as any).properties.domains.pattern);
      expect(pattern.test(Array(maximum).fill('example.com').join(separator))).toBe(true);
      expect(pattern.test(Array(maximum + 1).fill('example.com').join(separator))).toBe(false);
      expect(pattern.test('https://example.com/path')).toBe(false);
    }
  });
});
