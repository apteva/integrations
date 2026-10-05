import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getAppTemplate } from '../src/apps/index';
import { executeTool } from '../src/http-executor';

// Contract sources: https://rentahuman.ai/docs and
// https://hire-a-human.ai/blog/how-ai-agents-hire-humans-for-real-world-tasks
// Hire a Human's public app identifies its Supabase project. A read-only GET
// to that project's /functions/v1/api-tasks returns 401 Missing x-api-key header.
// The POST payload's exact schema remains undocumented; forward native JSON.
const app = (slug: string) => {
  const found = getAppTemplate(slug);
  if (!found) throw new Error(`Missing integration ${slug}`);
  return found;
};
async function request(slug: string, name: string, input: Record<string, unknown>, response: unknown = { success: true }) {
  const captured: { url: URL; headers: Headers; method: string; body: string }[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    captured.push({ url: new URL(req.url), headers: req.headers, method: req.method, body: await req.text() });
    return Response.json(response);
  }});
  try {
    const template = app(slug);
    const tool = template.tools.find(t => t.name === name)!;
    const result = await executeTool({ app: { ...template, base_url: `http://127.0.0.1:${server.port}` }, tool, credentials: { fields: { api_key: 'test-human-key' } }, input });
    return { result, captured };
  } finally { server.stop(true); }
}

describe('Human hiring connectors', () => {
  test('source and embedded catalogs stay identical, with distinct provider identities', () => {
    for (const slug of ['rentahuman', 'hire-a-human']) {
      const source = readFileSync(new URL(`../src/apps/${slug}.json`, import.meta.url), 'utf8');
      const embedded = readFileSync(new URL(`../../server/integrations-catalog/${slug}.json`, import.meta.url), 'utf8');
      expect(source).toBe(embedded);
      expect(app(slug).auth.credential_fields?.[0].required).toBe(true);
    }
    expect(app('hire-a-human').base_url).toBe('https://cwktwvmcxstpscjcmqzi.supabase.co/functions/v1');
    expect(app('hire-a-human').tools.map(t => `${t.method} ${t.path}`)).toEqual(['POST /api-tasks']);
    expect(app('hire-a-human').health_check).toBeUndefined();
  });

  test('Hire a Human forwards a native creation payload and full provider response', async () => {
    const task = { title: 'Phone outreach', description: 'Use the supplied brief.', providerSpecific: { zero: 0, flags: [false, true] } };
    const response = { task: { id: 'task-1' }, escrow: { status: 'requires_payment', url: 'https://example.com/checkout' } };
    const { result, captured } = await request('hire-a-human', 'create_task', { task }, response);
    expect(captured[0].url.pathname).toBe('/api-tasks');
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url.search).toBe('');
    expect(captured[0].headers.get('X-API-Key')).toBe('test-human-key');
    expect(captured[0].headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(captured[0].body)).toEqual(task);
    expect(result.data).toEqual(response);
  });

  test('RentAHuman caller screening preserves manual acceptance, level and schedules', async () => {
    const input = { title: 'Phone outreach pilot', description: 'Call businesses using our brief and log outcomes.', price: 50, priceType: 'fixed', dryRun: true, autoAccept: false, micCheckRequired: true, languageProficiencyRequirement: { language: 'en', minimumCefr: 'B2' }, scheduledStartAt: '2026-10-12T09:00:00+02:00', scheduledStartTimeZone: 'Europe/Madrid', completionWindowHours: 24 };
    const { captured } = await request('rentahuman', 'create_bounty', input);
    expect(JSON.parse(captured[0].body)).toEqual(input);
    const properties = app('rentahuman').tools.find(t => t.name === 'create_bounty')!.input_schema.properties as Record<string, any>;
    expect(properties.languageProficiencyRequirement.properties.language.enum).toEqual(['en']);
    expect(properties.priceType.enum).toEqual(['fixed', 'hourly']);
    expect(app('rentahuman').tools.some(t => t.name === 'start_conversation')).toBe(false);
  });

  test('worker removal uses query parameters on DELETE and release preserves acknowledgment', async () => {
    for (const name of ['unblock_human', 'unprefer_human']) {
      const { captured } = await request('rentahuman', name, { humanId: 'human-1' });
      expect(captured[0].method).toBe('DELETE');
      expect(captured[0].url.searchParams.get('humanId')).toBe('human-1');
      expect(captured[0].body).toBe('');
    }
    const { captured, result } = await request('rentahuman', 'release_payment', { escrowId: 'esc-1', applicationId: 'app-1', acknowledgeRelease: true }, { success: true, paymentReleased: true });
    expect(captured[0].url.pathname).toBe('/escrow/esc-1/release');
    expect(JSON.parse(captured[0].body)).toEqual({ applicationId: 'app-1', acknowledgeRelease: true });
    expect(result.data).toEqual({ success: true, paymentReleased: true });
  });
});
