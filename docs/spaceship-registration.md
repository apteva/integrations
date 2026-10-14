# Spaceship domain registration

Source: https://docs.spaceship.dev/#tag/Domain-Management/operation/domainCreate (checked October 14, 2026).

`register_domain` sends `POST /v1/domains/{domain}` with `autoRenew`, `years` (1–10), `privacyProtection` (`level`, `userConsent`) and `contacts` (registrant required; other roles and TLD-specific attribute IDs optional). Contact IDs are obtained using the existing contact/account-domain tools.

This is a billable request requiring `domains:billing`. It has no documented dry run, maximum-price field, or idempotency key. Require explicit user approval of account-rate billing and exact options. Never automatically repeat an uncertain submission. The tool declares zero retries.

HTTP 202 has no response body. A required `spaceship-async-operationid` response header identifies the accepted asynchronous operation. The catalog's `response_header_fields` mapping copies only that header into JSON as `operation_id`, allowing app callers to persist it independently of platform header allowlists. Unmapped response headers are never copied into the result body.

Use `get_async_operation` (requires `asyncoperations:read`) until `pending` becomes `success` or `failed`. A successful HTTP submission alone is not a successful registration. Inspect `get_domain_info` to confirm the domain belongs to the account. The domains app v1.1.0 implements this persisted confirmation/polling flow. Deploy the updated integration runtime and catalog together with that app.

Availability returns `result` and `premiumPricing`. An empty premium price array does not supply a standard registration quote. Do not present an estimated appraisal as a registrar price or claim a provider price ceiling.

Checks: `bun test test/spaceship-registration.test.ts test/domains-provider-contracts.test.ts` and `bun run build`. Tests use a local HTTP server and mock credentials; no paid registrations are made.
