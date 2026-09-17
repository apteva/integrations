import { OpenBankingClient, SyncError } from '@open-banking-io/client';
import type { ConnectionCredentials } from './types.js';
import type { ExecuteToolResult } from './http-executor.js';

// This provider returns encrypted envelopes and sync requires locally decrypted
// session IDs. Keep this flow in the SDK, never in model-visible tool arguments.
export async function executeOpenBankingIO(
  name: string, stored: ConnectionCredentials, input: Record<string, unknown>, timeout: number,
): Promise<ExecuteToolResult> {
  const credentials: Record<string, string | undefined> = { api_key: stored.api_key, ...stored.fields };
  try {
    const base = new URL(credentials.api_base_url?.trim() || "https://open-banking.io");
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      throw new Error('invalid configuration');
    }
    const signal = AbortSignal.timeout(timeout);
    const client = new OpenBankingClient({
      apiBaseUrl: base.href, apiKey: credentials.api_key || "",
      privateKeyPkcs8: credentials.private_key || "", timeoutMs: timeout,
      fetch: ((url, init) => fetch(url, { ...init, signal, redirect: 'error' })) as typeof fetch,
    });
    let data: unknown;
    const account = input.account_id;
    if (['list_transactions', 'sync_account'].includes(name) &&
        (typeof account !== 'string' || !account.trim())) {
      return { success: false, status: 400, data: { error: 'account_id is required' }, headers: {} };
    }
    const number = (key: string, min: number): number | undefined => {
      if (input[key] === undefined) return undefined;
      const value = Number(input[key]);
      if (!Number.isSafeInteger(value) || value < min) throw new Error('invalid pagination');
      return value;
    };
    switch (name) {
      case 'list_accounts': data = await client.getAccounts(); break;
      case 'list_connections': data = await client.getConnections(); break;
      case 'list_transactions': data = await client.getTransactions(account as string, {
        from: typeof input.from === 'string' ? input.from : undefined,
        to: typeof input.to === 'string' ? input.to : undefined,
        limit: number('limit', 1), offset: number('offset', 0),
      }); break;
      case 'sync_account': data = await client.sync(account as string); break;
      case 'sync_all': data = await client.syncAll(); break;
      default: return { success: false, status: 400, data: { error: 'Unsupported open-banking.io tool' }, headers: {} };
    }
    return { success: true, status: 200, data, headers: {} };
  } catch (error) {
    if (error instanceof SyncError) return {
      success: false, status: error.status,
      data: { error: 'Bank sync failed', reason: error.reason, bankErrorCode: error.bankErrorCode },
      headers: error.retryAfterSeconds != null ? { 'retry-after': String(error.retryAfterSeconds) } : {},
    };
    // SDK/transport error text can contain URLs; do not return credentials or session IDs.
    return { success: false, status: 502, data: { error: 'Open Banking Access request or decryption failed. Check credentials, API URL and bank consent.' }, headers: {} };
  }
}
