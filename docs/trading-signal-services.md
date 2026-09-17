# Trading signal services

Reviewed September 14, 2026. Scope: supported provider APIs in the integration
catalog; no trading orders, new accounts, subscriptions, or live credentials.

| Service | Catalog result | Scope |
| --- | --- | --- |
| Unusual Whales | `unusual-whales.json` | Seven read-only REST tools: flow alerts, recent/per-ticker dark-pool trades, market tide, news, user alerts, and stock info. Requires API access and bearer token. |
| altFINS | `altfins.json` | Official hosted MCP API, authenticated with X-API-Key. Vendor supplies the current screener, analytics, and signal tools; availability depends on API credits/permissions. |
| TrendSpider | `trendspider.json` | Documented shared-content grant/revoke API only. Trading signals are delivered by outbound webhooks, not this API. |
| TradingView | No REST catalog added | Official support explicitly says no API for retrieving data or indicator values. The published REST specification is for brokers implementing TradingView integration. Alerts support outbound webhooks. |
| Trade Ideas | No catalog added | No documented public signal API contract found on the official site or in the help-center API search. Broker connections and browser-internal interfaces are not public signal APIs. |
| Tickeron | No catalog added | Could not verify a supported public API contract. Official site/API-page reads returned HTTP 403; availability remains unconfirmed. |

All new integration display names, slugs, and local tool names are dot-free.
The hosted altFINS tool catalog is supplied at connection time, so this static
check does not validate its future upstream tool names. No Core changes.

## Setup and behavior

Unusual Whales: obtain an API token with the required endpoint entitlements.
The catalog follows its public OpenAPI spec and avoids the deprecated
stock-specific flow-alert route. `list_flow_alerts` accepts `ticker_symbol`
and supports repeated `rule_name[]` query values. Optional filter defaults
are intentionally omitted to avoid accidentally filtering out signals.
Results retain provider metadata. These signals are market observations,
not order instructions.

altFINS: create a key at https://altfins.com/profile?tab=api-key. The JSON uses
`kind: remote_mcp`, URL `https://mcp.altfins.com/mcp`, and the documented
`X-API-Key` header. There is no invented local tool catalog.

TrendSpider: share an item using “Share to certain people only”, then open
Sharing Management > API > Copy credentials. Split `itemId/secretKey` into
the two connection fields. A connection represents one shared item. Grant
and revoke take exactly one existing TrendSpider account email; actions take
effect immediately. HTTP-200 `success:false` responses count as failures.
Each tool is paced at six seconds per connection (ten calls/minute each,
within the documented twenty/minute across both tools on the same connection).
Multiple connections using the same item still share the upstream limit.
No health check mutates subscriber access.

## Validation

Tests exercise each REST route, auth, query arrays and false values,
credential path escaping, response-error detection, hosted MCP generation,
dot-free names, and exact bundled-catalog parity. Authenticated provider
calls were not performed. The server changes are bundled JSON copies only.

## Official references

- Unusual Whales docs: https://api.unusualwhales.com/docs
- Unusual Whales OpenAPI: https://api.unusualwhales.com/api/openapi
- altFINS API: https://altfins.com/crypto-market-and-analytical-data-api/documentation/api/search
- altFINS API keys: https://altfins.com/knowledge-base/how-to-create-an-altfins-api-key-step-by-step-guide/
- altFINS official MCP setup: https://altfins.com/knowledge-base/how-to-build-a-live-multi-timeframe-rsi-crypto-screener-with-claude-code-and-the-altfins-api-2026-guide/
- TrendSpider API: https://help.trendspider.com/kb/sharing-content/using-api-to-manage-access-to-your-shared-entities
- TrendSpider webhooks: https://help.trendspider.com/kb/webhooks-56eab0912c4ac1ec
- TradingView API limitation: https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/
- Trade Ideas API search: https://help.trade-ideas.com/search?query=API
- Tickeron: https://tickeron.com/
