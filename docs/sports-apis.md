# Sports APIs

The catalog adds 19 providers and 166 read-only tools. Definitions live in `src/apps/` and are mirrored in `../server/integrations-catalog/` for embedding in the server binary. Discovery is automatic; no registration index is needed.

These integrations use documented request/response JSON APIs. There are no RSS/XML feeds, downloadable datasets, CSV endpoints, website scraping, or streaming subscriptions. Data Golf uses a host named `feeds.datagolf.com`, but the included tools call its documented HTTP API with `file_format=json`.

## Providers and setup

Connect a provider in Integrations and enter the credentials listed below. Endpoint availability depends on the provider account's plan and data rights. Free access does not necessarily permit commercial use. Follow the linked provider documentation for current limits and licensing.

| Provider | Tools | Credentials | Documentation |
| --- | ---: | --- | --- |
| [OpenLigaDB](../src/apps/openligadb.json) | 11 | None | [Official docs](https://api.openligadb.de) |
| [OpenDota](../src/apps/opendota.json) | 11 | None | [Official docs](https://docs.opendota.com/) |
| [Squiggle AFL](../src/apps/squiggle.json) | 8 | Contact email | [Official docs](https://api.squiggle.com.au) |
| [Jolpica F1](../src/apps/jolpica-f1.json) | 10 | None | [Official docs](https://github.com/jolpica/jolpica-f1) |
| [OpenF1](../src/apps/openf1.json) | 9 | Live access Authorization header (optional) | [Official docs](https://openf1.org/docs/) |
| [CollegeFootballData](../src/apps/college-football-data.json) | 10 | API token | [Official docs](https://api.collegefootballdata.com/) |
| [The Racing API](../src/apps/the-racing-api.json) | 12 | API username, API password | [Official docs](https://api.theracingapi.com/documentation) |
| [SportsGameOdds](../src/apps/sportsgameodds.json) | 7 | API key | [Official docs](https://sportsgameodds.com/docs/) |
| [football-data.org](../src/apps/football-data-org.json) | 10 | API key | [Official docs](https://docs.football-data.org/general/v4/index.html) |
| [CricketData / CricAPI](../src/apps/cricketdata.json) | 8 | API key | [Official docs](https://cricketdata.org/how-to-use-cricket-data-api.aspx) |
| [BALLDONTLIE NBA](../src/apps/balldontlie.json) | 9 | API key | [Official docs](https://nba.balldontlie.io/) |
| [Sportmonks Football](../src/apps/sportmonks-football.json) | 8 | API key | [Official docs](https://docs.sportmonks.com/v3/) |
| [PandaScore](../src/apps/pandascore.json) | 9 | API token | [Official docs](https://developers.pandascore.co/) |
| [SharpAPI Sports Odds](../src/apps/sharpapi.json) | 6 | API key | [Official docs](https://docs.sharpapi.io/en/) |
| [Odds-API.io](../src/apps/odds-api-io.json) | 10 | API key | [Official docs](https://docs.odds-api.io/) |
| [Betfair Exchange Market Data](../src/apps/betfair-exchange.json) | 5 | Application key, Session token | [Official docs](https://developer.betfair.com/) |
| [Data Golf](../src/apps/datagolf.json) | 8 | API key | [Official docs](https://datagolf.com/api-access) |
| [API Tennis](../src/apps/api-tennis.json) | 8 | API key | [Official docs](https://api-tennis.com/documentation) |
| [Sportradar Soccer](../src/apps/sportradar.json) | 7 | API key, Access level (optional), Language code (optional) | [Official docs](https://developer.sportradar.com/soccer/reference/soccer-api-overview) |

## Access and usage details

- OpenLigaDB, OpenDota, Jolpica F1, and historical OpenF1 work without an API key. Squiggle also requires no key, but asks for an operator contact email in the User-Agent header.
- Jolpica's noncommercial license and OpenF1's usage terms need attention for commercial applications. PandaScore's free statistics access excludes betting use.
- BALLDONTLIE currently covers its NBA API; Sportradar covers Soccer v4. Credentials for other products do not unlock these endpoints.
- The Racing API includes its documented free-plan racecards and today's results, plus paid-plan endpoints. Sportmonks, football-data.org, CollegeFootballData, CricketData, SportsGameOdds, and BALLDONTLIE also have plan-specific restrictions; a working connection does not imply every tool is entitled.
- Odds-API.io supports existing or paid keys; new free-key issuance was paused when researched. SharpAPI and API Tennis access depends on the current trial/subscription. Data Golf's tools require the corresponding API membership.
- Betfair requires an application key and a valid session token. Its five POST operations only read market data. Supply/refresh the session token separately. `get_market_book` requires `priceProjection.priceData`, such as `["EX_BEST_OFFERS"]`, to request prices.
- OpenF1 accepts an optional complete `Bearer TOKEN` value for entitled live access. Token acquisition and refresh remain external to this catalog integration.
- Sportradar defaults to trial access and English; select production and the desired language in its connection fields as appropriate.
- Tools preserve pagination metadata. Pass returned cursors or offsets to the next call. BALLDONTLIE array filters use repeated bracketed query names; The Racing API uses repeated unbracketed names.
- Per-tool pacing and bounded HTTP 429 retries reduce bursts. They do not enforce aggregate provider quotas across tools, connections, or processes. Cache stable reference data and follow provider-wide request/object/credit limits.
- CricketData's echoed API key is omitted from successful and failed results. Its quota metadata remains available. CricketData and API Tennis HTTP-200 failure envelopes are reported as unsuccessful operations.
- Pinnacle is excluded because general API access is restricted. No wagering/order tools are included.
- The existing The Odds API entry now correctly describes its free allocation as credits and names the `oddsFormat` parameter.

## Verification

`bun run build` and the full integration test suite (339 tests) pass. Provider-contract tests in `test/sports-api-catalog.test.ts` exercise authentication, query aliases, repeated arrays, nested Betfair bodies, pagination retention, semantic errors, URL interpolation, and catalog parity.

Live smoke checks on 2026-09-09, through the actual TypeScript executor, returned HTTP 200 for OpenLigaDB (13 sports), OpenDota (127 heroes), Jolpica F1 (one race), OpenF1 (25 meetings for 2025), and Squiggle (18 teams). These check representative public endpoints; key-protected providers have contract tests but have not been authenticated against paid accounts.

Focused Go server tests pass with Go 1.26.6. Tests in `integrations_sports_test.go` verify that all 19 catalogs embed and that CricketData credentials are removed on success, HTTP errors, and semantic errors. Deployment requires rebuilding/restarting the server; this change does not deploy or activate provider accounts.
