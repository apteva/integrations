# Open Banking Access (open-banking.io)

Account data connector with five tools: `list_accounts`, `list_transactions`,
`list_connections`, `sync_account`, and `sync_all`. No payment initiation.

## Setup

1. Create an account at https://open-banking.io and connect your banks there.
2. Export `credentials.json` from the provider's Developers page.
3. Create an **Open Banking Access** connection in Apteva. The API URL defaults to `https://open-banking.io`; change the optional override
   only if your bundle specifies a different `apiBaseUrl`. Copy `apiKey` to **API Key**, and
   `encryptionKey.privateKey` to **Encryption Private Key**.
   The key is base64 PKCS#8 P-256, not the browser passphrase or public key.
4. Run `list_accounts` to verify authentication and decryption.
5. Use `sync_account` or `sync_all` from an existing scheduled workflow, then
   read transactions with `from`, `to`, `limit` and `offset` for reconciliation.

The API URL must use HTTPS; redirects are refused to prevent credential forwarding.
The default is the provider URL, not your Apteva public URL or the localhost example
in the developer documentation.
Credentials are managed by the existing connection secret store. Do not place the
bundle in tool arguments, prompts, logs or source control. The private key stays
in the Apteva server process; only locally decrypted session identifiers are sent
back to the provider when requesting a sync. Read responses omit those identifiers.
The provider transiently processes bank data during sync before encrypting it at rest.

## Runtime and limitations

Both the TypeScript executor and Go server use pinned official SDKs for authenticated
requests, ECDH P-256/HKDF-SHA256/AES-GCM decryption, and bounded stale-session retries.
The TypeScript SDK requires Node 20+ (Bun is supported by the workspace).
Rebuild/restart the server to load its embedded catalog and Go adapter.

Money stays in decimal strings. Field names use camelCase in both runtimes;
Go optional text fields are empty strings where the TypeScript SDK returns null.
`sync_all` may return a successful request with individual `failures`; inspect
those before treating an import as complete. Single-account sync errors preserve
provider status, reason, bank error code and Retry-After where supplied.

Expired consent requires the user to reconnect in the provider app. Background
sync never fabricates user-presence/IP headers; banks requiring user presence can
refuse it. This connector neither starts a bank consent flow nor creates a schedule
by itself. It does not send payments.

Validation uses public synthetic upstream encrypted fixtures and mocked HTTP.
No live account connection, deployment or bank transaction was performed.

References: [SDKs](https://github.com/open-banking-io/clients),
[Developer docs](https://open-banking.io/en/developers),
[Security](https://open-banking.io/en/security).
