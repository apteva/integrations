# Enable Banking and Yapily

These catalog entries cover account-information automation: institution discovery,
bank authorization, accounts, balances, transactions and consent/session management.
Enable Banking also supports PIS payment creation, authorization/submission and
status tools; see [Payment products](payment-products.md). API responses retain pagination and
consent metadata. No provider signup, bank connection or deployment is performed
by adding the catalog entries.

## Enable Banking (`enable-banking`)

1. Register an application at https://enablebanking.com/cp/applications. Register
   its callback URL and generate/export an RSA private key in the control panel,
   or upload a certificate for an RSA key you already control.
2. Configure the integration's **Application ID** and **Application RSA Private
   Key**. The application registration determines sandbox or production; both
   use `https://api.enablebanking.com`.
3. For restricted production, link your own accounts in the control panel.
   This enables individual non-commercial use/evaluation; broader commercial
   access requires an agreement. Whitelisting does not replace API authorization.
4. Call `list_banks` with `country: ES`, `service: AIS` and the correct
   `psu_type` (`personal` or `business`). Check bank capabilities and
   `maximum_consent_validity`.
5. Call `start_authorization` with the exact bank name/country, requested access
   and expiry, registered redirect URL, correct PSU type and an unpredictable
   `state`. The account holder completes the returned URL in a browser.
6. Validate the callback `state`, then call `authorize_session` with its `code`.
   Persist the returned session ID, account `uid`s and `identification_hash`es.
   Fetch balances and transactions using those account IDs.

Both the TypeScript executor and Go server generate RS256 JWTs per request with
application ID in `kid`, issuer `enablebanking.com`, audience
`api.enablebanking.com`, and a 15-minute lifetime. The private key never becomes
a tool argument or request body. PKCS#1/PKCS#8 RSA PEMs and escaped/flattened
pasted PEMs are supported. No manual bearer-token renewal is needed.

For transactions, follow `continuation_key` until null, even when a page is empty.
Use stable `entry_reference` for deduplication where supplied, and
`identification_hash` to match accounts after reauthorization (account IDs change).
Reauthorize when the session expires or the provider returns `EXPIRED_SESSION`.
Many banks allow four background fetches daily and consent up to 180 days;
read each bank's actual limits. Do not supply PSU headers for background sync;
forward genuine user context only for user-initiated requests.

## Yapily (`yapily`)

1. Create an application in https://console.yapily.com/ and configure its
   institutions, callback URLs and sandbox/live access.
2. Enter **Application ID** and **Application Secret**. These are stored as
   `username` and `password` and used for HTTP Basic authentication.
3. Call `list_institutions`. Select a bank supporting country `ES` and the
   required account-information features. Coverage depends on the application.
4. Call `create_account_authorization` with `institutionId` and either
   `applicationUserId` or `userUuid`. Prefer a registered `callback` and
   `oneTimeToken: true`. The account holder completes `authorisationUrl`.
   Some institutions require preauthorization: use `create_preauthorization`
   and `update_account_preauthorization` according to institution features.
5. Exchange the callback's one-time token with `exchange_one_time_token`.
   `exchange_authorization_code` supports the OAuth code/state flow when used.
   Store the resulting `consentToken` securely; it is distinct from `consentId`.
6. Supply the correct `consent` token on each account-data call. The runtime sends
   it as a header, alongside Basic authentication; it is not a query parameter.
   Optional PSU identifiers/IP and sub-application headers are also mapped to
   headers rather than query/body fields.

Use `limit` and `offset` for transaction pagination and retain response metadata.
Use `get_consent`, `reauthorize_account_consent` and `delete_consent` to manage
connections. `extend_consent` is only for actual user reconfirmation, with its
true `lastConfirmedAt`; it is not an unattended substitute for authorization.
Free sandbox access does not imply free live access.

## Sources and validation

- https://enablebanking.com/docs/api/reference/
- https://enablebanking.com/docs/api/linked-accounts/
- https://enablebanking.com/docs/faq/
- https://github.com/yapily/yapily-openapi/blob/master/openapi.json (API 12.17.1)
- https://docs.yapily.com/

The Yapily schemas/routes were checked against the official OpenAPI definition.
Local tests verify cryptographic signatures, required credentials, authorization
bodies, consent/header placement, and pagination preservation in both runtimes.
Live API behavior still requires configured provider credentials and bank consent.

The new JSONs are mirrored into `server/integrations-catalog` for the next server
build. Enable Banking requires that build's new `enable_banking_jwt` signer; an
older running server cannot execute it by loading only the JSON.
