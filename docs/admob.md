# Google AdMob integration

The `admob` connector provides read-only publisher inventory and analytics through
the stable AdMob v1 API. The Analytics app can consume these tools through its
integration binding.

## Connection

Enable the AdMob API in the Google Cloud project used for OAuth. Configure a Google
OAuth client and register Apteva's displayed callback URL. Connect AdMob through
Google sign-in with a user who has access to the publisher account. The connector
requests `https://www.googleapis.com/auth/admob.readonly`, offline access and consent
so the platform can renew access tokens. OAuth-generated fields are hidden.

`list_accounts` is the connection health check. Google's account-list endpoint
returns the publisher account most recently signed in to in the AdMob UI; it is
not a complete enumeration of every account the user might manage. Pass the
returned `publisherId` (for example `pub-9876543210987654`) as `account_id`, without
the `accounts/` prefix.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Find the accessible publisher account |
| `get_account` | Read account currency and reporting time zone |
| `list_apps` | Paginated app inventory |
| `list_ad_units` | Paginated ad-unit inventory |
| `generate_network_report` | AdMob Network earnings and ad performance |
| `generate_mediation_report` | Mediation earnings, ad sources and observed eCPM |

Inventory responses retain `nextPageToken`. Report requests use POST with a nested
`reportSpec`. Example network report input:

```json
{
  "account_id": "pub-9876543210987654",
  "reportSpec": {
    "dateRange": {
      "startDate": { "year": 2026, "month": 8, "day": 1 },
      "endDate": { "year": 2026, "month": 8, "day": 31 }
    },
    "dimensions": ["DATE", "APP", "COUNTRY"],
    "metrics": ["ESTIMATED_EARNINGS", "IMPRESSIONS", "CLICKS", "IMPRESSION_RPM"],
    "dimensionFilters": [
      { "dimension": "COUNTRY", "matchesAny": { "values": ["US"] } }
    ],
    "localizationSettings": { "currencyCode": "USD" },
    "maxReportRows": 10000
  }
}
```

For mediation, use supported metrics such as `OBSERVED_ECPM` and dimensions such as
`AD_SOURCE`, `AD_SOURCE_INSTANCE` and `MEDIATION_GROUP`. Dates are inclusive. Select
at most one of `DATE`, `MONTH` or `WEEK`. Network `AD_TYPE` is incompatible with
`AD_REQUESTS`, `MATCH_RATE` and `IMPRESSION_RPM`.

## Reading reports

REST reports return a JSON array containing a header, row messages and a footer.
The connector preserves the entire array:

- Read currency and reporting time zone from the header. Omitting request
  overrides uses account defaults; the only explicit time-zone override currently
  supported by this API is `America/Los_Angeles`.
- Monetary `microsValue` strings represent millionths of a currency unit. For
  example, `6500000` means 6.50 in the report currency. Preserve integer precision
  when parsing; values can exceed JavaScript's safe integer range.
- Ratios such as `IMPRESSION_CTR` are decimal ratios, not percentage points.
- Inspect the footer's warnings and `matchingRowCount`. Report generation is
  capped at 100,000 rows and has no page token. If truncated, split date ranges or
  filters. A missing footer or an error message must not be treated as a complete
  report. HTTP success alone does not certify completeness or finalized earnings.

Source and server catalog copies must stay synchronized. Contract tests mock
Google's HTTP responses; live OAuth and publisher data require an account.

## Official references

- https://developers.google.com/admob/api/v1/how-tos/authorizing
- https://developers.google.com/admob/api/reference/rest/v1/accounts/list
- https://developers.google.com/admob/api/reference/rest/v1/accounts.apps/list
- https://developers.google.com/admob/api/reference/rest/v1/accounts.adUnits/list
- https://developers.google.com/admob/api/reference/rest/v1/accounts.networkReport/generate
- https://developers.google.com/admob/api/reference/rest/v1/accounts.mediationReport/generate
- https://admob.googleapis.com/$discovery/rest?version=v1

Checked against Google's documentation and discovery schema on 2026-09-07.
