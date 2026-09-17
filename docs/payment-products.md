# Payment products and authorization

## Implemented connectors

| Connector | Payment capability | Activation |
| --- | --- | --- |
| `enable-banking` | PIS bank discovery, create/get payment, submit authorized deferred payment, get transaction status | Enable PIS on the application; existing RSA credentials are reused. |
| `plaid` | Payment Initiation recipients/payments/Link; US Transfer authorization/create/get/cancel; Transfer event list/sync | UK/EU Payment Initiation and US Transfer are separate products. |
| `teller` | Beta Zelle payee/payment create/list/get, capability discovery via OPTIONS, mTLS and idempotency | Bank/product must permit payments; inspect account.links.payments and schemes. |
| `truelayer-payments` | Payments v3 create/get, provider discovery, authorization start and provider/consent/form actions | Separate Payments client ID/secret, payments scope, signing KID and EC P-521 private key. |
| `saltedge-payments` | v6 PIS provider/template discovery, customer/payment create, payment get/list, Widget consent URL | PIS-enabled App-id/Secret and registered RSA signing key. |
| `nordigen` | Account information only | Bank Account Data has no payment endpoints. |

The existing `truelayer` and `saltedge` connectors remain account-data connectors.
No payment deletion is presented as cancellation. No Salt Edge cancellation route
is declared. Direct-debit collections, refunds, payouts and merchant operations
are separate product/workflow additions.

## Enable Banking

1. Discover `list_banks` with `service: PIS`, `country: ES`, and the appropriate
   `psu_type`. Choose a supported payment type from that bank's metadata.
2. `create_payment` accepts `payment_type`, `aspsp`, `psu_type`, `redirect_url`,
   unpredictable `state`, and `payment_request.credit_transfer_transaction`.
   Each transaction has `beneficiary.creditor.name`,
   `beneficiary.creditor_account.{identification,scheme_name}`,
   `instructed_amount.{amount,currency}` and optional
   `remittance_information` (array of strings) / `payment_id.end_to_end_id`.
3. For authorization before submission, explicitly send `defer_submission: true`
   only if the bank's payment type advertises `deferred_submission_supported`.
   Persist the returned payment ID and direct the user to the returned bank
   authorization URL. Verify redirect state and fetch payment status.
4. After authorization, call `submit_payment`. Use `get_payment` and
   `get_payment_transaction` for subsequent status.

Responses remain complete. Creation can be ambiguous on timeout; do not blindly
resubmit. `DELETE /payments/{id}` is intentionally absent: it deletes finished
or failed records, not an in-flight transfer.

## Plaid

For `user_action_required` from US Transfer authorization, create Link with
`transfer.authorization_id` and the relevant user/product configuration. The
user must finish Link before the application resumes the authorization workflow.
Payment Initiation uses `payment_initiation.payment_id` instead.

`sync_transfer_events` takes `after_id` (0 initially) and `count`. Persist the
largest processed event ID transactionally with your status changes. Continue
until caught up. Treat verified `TRANSFER_EVENTS_UPDATE` webhooks as wakeups to
sync. `list_transfer_events` supports filtered inspection. Returns, failures,
settlement and reversals must update the existing intent, not create a new one.

`cancel_transfer` is eligible only while `/transfer/get` returns
`cancellable: true`; the provider makes the final eligibility decision, which can
change between reads. `get_payment_recipient` and `list_payment_recipients`
manage existing Payment Initiation recipients (follow returned `next_cursor`).

## Teller

A missing `account.links.payments` means no payment origination. The account tool
preserves this link. `get_payment_capabilities` sends a bodyless
`OPTIONS /accounts/{account_id}/payments` and returns the supported schemes.
Do not label Zelle as general ACH, SEPA or wire support.

`create_payment` requires a stable `idempotency_key`, sent as `Idempotency-Key`.
The payee is a JSON object. A returned `connect_token` is preserved: initialize
Teller Connect with `connectToken` and let the account holder complete MFA.
A challenge or payment record is not proof of settlement. The connector exposes
these responses; a Teller Connect UI in Finance is not implemented here.

## TrueLayer Payments v3

Select `truelayer-sandbox` or `truelayer` in the connection. The runtime exchanges
client credentials for a token with `scope: payments` using the matching auth
host and renews it automatically. It uses the current `/v3/` endpoint paths.

Backend mutation/authorization calls carry a stable UUID `Idempotency-Key` and
an ES512 detached `Tl-Signature` (version 2), signing the exact HTTP method, path,
header and final serialized body. Both TypeScript and Go runtimes support this.

Payment creation exposes the documented payment method/beneficiary, user,
amount/currency, `hosted_page` or `authorization_flow` schemas. For a custom flow,
start authorization then follow the returned `next` action: provider selection,
consent, form or bank redirect. Only submit consent actually given by the user.
The full redirect/status/resource-token responses are retained. `get_payment`
retrieves authoritative status; authorization/execution are not settlement.

## Salt Edge Payment Initiation v6

The provider's current v6 docs explicitly include PIS. These routes are separate
catalog tools backed by PIS credentials, not guessed routes on the AIS connector:

- `GET /providers?include_pis_fields=true`
- `GET /providers/{provider_code}?include_pis_fields=true`
- `GET /payment_templates` and `GET /payment_templates/{template_identifier}`
- `POST /customers`
- `POST /payments/create`
- `GET /payments/{payment_id}` and `GET /payments`

Inspect provider-specific templates before creating a payment. Supply
`template_identifier`, `payment_attributes` and customer identity (`customer_id`
is mandatory for Partners). Common payment attributes include `end_to_end_id`,
`description` and the actual `customer_ip_address`; template/provider-specific
fields cover beneficiary, amount, currency and reference. SEPA supports
`creditor_iban`, `debtor_iban` and `currency_code`.

The runtime wraps create payloads in `data` and signs
`Expires-at|METHOD|full_url|exact_body` with RSA-SHA256. GET signs an empty body.
The returned `data.payment_url` opens Salt Edge Widget for bank consent.
Use `attempt.return_to` and `attempt.custom_fields.state` for the user flow.
Persist `payment_id` and retrieve current status; do not treat Widget success as
settlement or retry unknown creation outcomes without reconciliation.

## Verified webhook ingress

Create a **connection-bound webhook subscription** in Apteva. Register its public
URL with the provider: TrueLayer Console's Payments webhook URI, Plaid's configured
Transfer webhook, or Salt Edge PIS callback settings. These providers do not use
the generic HMAC secret shown for subscriptions; their asymmetric verification
runs before dispatch to an agent, even if no HMAC secret was supplied.

- **Plaid:** `Plaid-Verification`, ES256, key lookup through the connection's
  trusted sandbox/production host; reject expired keys, JWTs older than five
  minutes or over 30 seconds in the future, and mismatched raw body SHA256.
- **TrueLayer:** `Tl-Signature`, ES512/v2 detached signature over raw body,
  request path and declared headers. JKU must exactly match the connection's
  production or sandbox `.well-known/jwks` URL. Redirects from key lookups are
  rejected. Verification is tested against the provider's public fixture.
- **Salt Edge:** `Signature-key-version: 6.0`, RSA-SHA256 using the public key
  published in the v6 callback docs, over `callback_url|raw_body`. Configure the
  exact public subscription URL in the connection's `callback_url` field; its
  path/query must match ingress. Unknown key versions fail closed until updated.

Raw bytes are verified before the existing subscription dispatcher forwards the
complete JSON event. Consumers still need durable event deduplication and status
reconciliation: signatures establish authenticity, not exactly-once processing.
TrueLayer retries and Salt Edge callbacks can repeat; never initiate a second
payment merely because a notification is repeated. Persist payment IDs and fetch
current status on callbacks to handle out-of-order delivery.

This work adds connector tools, signing and verified server ingress. It does not
add Finance's durable payment-intent database/UI or execute any live transaction.
Rebuild/restart the server to load the new signers, ingress verification and
embedded catalogs, then configure product access and complete bank consent.

## Sources

- https://enablebanking.com/docs/api/reference/
- https://github.com/plaid/plaid-openapi/blob/master/2020-09-14.yml
- https://plaid.com/docs/api/webhooks/webhook-verification/
- https://teller.io/docs/api/account/payments
- https://docs.truelayer.com/reference/create-payment
- https://docs.truelayer.com/reference/start-payment-authorization-flow
- https://docs.truelayer.com/docs/configure-webhooks-for-your-integration
- https://github.com/TrueLayer/truelayer-signing/blob/main/request-signing-v2.md
- https://docs.saltedge.com/v6/api_reference#pis-payments-create
- https://docs.saltedge.com/v6/#security-signature-headers
- https://docs.saltedge.com/v6/#callbacks-request-identification-signature
