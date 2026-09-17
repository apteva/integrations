# Banking connector corrections and payment readiness

This is the earlier connector audit. The payment-specific connector additions,
signing and verified callback receiver are now implemented; see
[Payment products](payment-products.md) for the current capability matrix.
The durable Finance money-movement workflow remains separate.

## Corrected connector contracts

- **Plaid reads:** account filters and historical transaction count/offset are
  serialized into `options` where required. Existing flat inputs remain supported
  as explicit aliases, so Finance's current calls continue to work. Native
  `options` is also accepted; explicit aliases override matching options fields.
  `/transactions/sync` is different: `count` and `cursor` remain top-level,
  filtering uses `options.account_id` (singular), and each filter needs its own
  cursor. Recurring transactions keep top-level `account_ids`.
  Institution search has no count/offset pagination; those fields were removed.
- **Plaid Payment Initiation:** `create_payment` now exposes `user_id` for new
  integrations. `create_user` provides `/user/create`. `create_link_token`
  exposes `user_id`, `payment_initiation` and `hosted_link`. Create the payment,
  configure Link with its payment ID and `products: ["payment_initiation"]`,
  let the account holder authorize, then track the payment's actual status.
  Creating a Link token does not launch a consent UI or complete authorization.
- **Plaid US Transfer:** authorization/create tools now expose their documented
  `idempotency_key` inputs. This is provider-level retry support, not a completed
  Finance transfer workflow.
- **Teller:** payee/payment writes now use JSON. Payments take a nested `payee`
  with scheme/address (plus name/type for a new payee), not `payee_id`.
  `idempotency_key` is required by our payment tool and sent as `Idempotency-Key`.
  Persist the key before submitting and reuse it for the same intent/payload;
  Teller retains its idempotency behavior for 72 hours.
- **Nordigen/GoCardless Bank Account Data:** removed `initiate_payment` and
  `get_payment`. The configured Bank Account Data v2 OpenAPI has 14 paths and
  no payment endpoints. Existing account-information tools remain available.

## Work still needed before Finance can move money

Finance's `txns_transfer` remains ledger-only. These connector corrections do
not enable bank transfers or change connection permissions.

| Product | Remaining work |
| --- | --- |
| Plaid US ACH Transfer | Durable Finance payment intents scoped to project/connection; distinct persisted authorization/create keys; prevent concurrent duplicate submission and key reuse with different payloads; inspect authorization decision before create; store provider IDs and status; reconcile ambiguous timeouts; poll/event-sync status through returns and reversals. |
| Plaid Payment Initiation | Product-enabled account, payment-specific Link or Hosted Link UI/callback flow, and persisted payment status. This is separate from US ACH Transfer. |
| Teller beta Zelle | Check `account.links.payments`; where available, use `OPTIONS /accounts/{account_id}/payments` to verify supported schemes. Our current tool catalog does not expose OPTIONS. On `connect_token`, initialize Teller Connect using `connectToken` and let the account holder complete MFA. Retain a pending-authorization state; a 200 containing a challenge is not a completed payment. Then reconcile through payment retrieval/listing without creating another intent. No Connect UI/callback implementation is included in this correction. |
| GoCardless replacement | Choose an actual payment product suited to the desired payment type/countries, create a separate connector/connection, and configure its credentials, consent and status workflow. Bank Account Data cannot acquire payment capability through broader write permissions. |
| TrueLayer Payments v3 | Separate Payments integration, product credentials/scopes, `Tl-Signature` request signing, authorization UI/callbacks, idempotency, and status tracking. The existing TrueLayer connector is for Data API access. |
| Salt Edge Payment Initiation | Separate payment-product access/authentication, payment creation, bank consent and status tracking. The existing Salt Edge connector provides account information. |

No live payments, bank consents, provider signups or deployments were performed.
The three changed JSONs are mirrored in `server/integrations-catalog`; running
instances need the updated catalog through their normal build/release process.

## Sources

- Plaid official OpenAPI: https://github.com/plaid/plaid-openapi/blob/master/2020-09-14.yml
- Plaid payment initiation: https://plaid.com/docs/api/products/payment-initiation/
- Plaid Transfer: https://plaid.com/docs/api/products/transfer/
- Teller payment payloads, MFA, idempotency and capability discovery: https://teller.io/docs/api/account/payments
- GoCardless Bank Account Data schema: https://bankaccountdata.gocardless.com/api/v2/swagger.json
