import { test, expect, afterEach } from 'bun:test';
import { executeTool } from '../src/http-executor';
import app from '../src/apps/open-banking-io.json';
import bundle from './fixtures/open-banking-io/credentials.json';
import accounts from './fixtures/open-banking-io/accounts.json';
import transactions from './fixtures/open-banking-io/transactions.json';
import type { AppTemplate } from '../src/types';
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const credentials = { api_key: bundle.apiKey, fields: { api_base_url: 'https://bank.test', private_key: bundle.encryptionKey.privateKey } };
const call = (name: string, input = {}) => executeTool({ app: app as AppTemplate, tool: app.tools.find(t => t.name === name)! as any, credentials, input });
test('decrypts accounts and transactions without exposing encrypted session fields', async () => {
  globalThis.fetch = (async (url, init) => {
    expect(new Headers(init?.headers).get('X-Api-Key')).toBe(bundle.apiKey);
    expect(JSON.stringify(init)).not.toContain(bundle.encryptionKey.privateKey);
    expect(init?.redirect).toBe('error');
    return Response.json(String(url).includes('/transactions') ? transactions : accounts);
  }) as typeof fetch;
  const result = await call('list_accounts');
  expect(result.success).toBe(true);
  const first = (result.data as any[])[0];
  expect(first.iban).toBeTruthy();
  expect(typeof first.balances[0].amount).toBe('string');
  expect(first.uidEnc).toBeUndefined();
  const page = await call('list_transactions', { account_id: accounts[0].id, limit: 2, offset: 0 });
  expect(page.success).toBe(true);
  expect(typeof (page.data as any).items[0].amount).toBe('string');
});
test('sync derives uid locally and preserves bank refusal details', async () => {
  globalThis.fetch = (async (url, init) => {
    if (!String(url).endsWith('/sync')) return Response.json(accounts);
    const body = JSON.parse(String(init?.body));
    expect(typeof body.uid).toBe('string');
    expect(Object.keys(body)).toEqual(['uid']);
    return Response.json({ reason: 'reconnect_needed', bankErrorCode: 'expired' }, { status: 409 });
  }) as typeof fetch;
  const result = await call('sync_account', { account_id: accounts[0].id });
  expect(result.success).toBe(false);
  expect(result.status).toBe(409);
  expect((result.data as any).reason).toBe('reconnect_needed');
});
test('rejects tampered ciphertext rather than returning partial data', async () => {
  globalThis.fetch = (async () => Response.json([{ ...accounts[0], enc: 'corrupt' }])) as typeof fetch;
  expect((await call('list_accounts')).success).toBe(false);
});
test('sync all preserves partial failures', async () => {
  globalThis.fetch = (async (url, init) => {
    if (!String(url).endsWith('/api/sync')) return Response.json(accounts);
    expect(JSON.parse(String(init?.body)).items.length).toBeGreaterThan(0);
    return Response.json({ accounts: 0, newTransactions: 0, failures: [{ accountId: accounts[0].id, reason: 'reconnect_needed' }] });
  }) as typeof fetch;
  const result = await call('sync_all');
  expect((result.data as any).failures[0].reason).toBe('reconnect_needed');
});
