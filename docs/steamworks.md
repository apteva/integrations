# Steamworks publisher integration

Connect `steamworks` with a publisher Web API key from Steamworks that has access
to the intended apps. This is different from a personal community Web API key.
The connector executes on the server and exposes five tools:

| Tool | Steam method |
| --- | --- |
| `list_apps` | `GetPartnerAppListForWebAPIKey/v2` |
| `list_builds` | `GetAppBuilds/v1` |
| `list_branches` | `GetAppBetas/v1` |
| `get_depot_versions` | `GetAppDepotVersions/v1` |
| `set_build_live` | `SetAppBuildLive/v2` |

Requests use the partner host. Reads send query parameters; promotion uses POST
with a URL-encoded form, including the publisher key. The current shared executor
also includes query-auth credentials in the POST URL, so avoid logging full URLs.
Responses retain Steam's full body and the HTTP status; there is no inferred
"published" state or undocumented response-envelope validation.

## Upload and promotion workflow

1. Configure the app, launch options, depots and branches in Steamworks.
2. Install the Steamworks SDK ContentBuilder/SteamCMD on the build runner. Use a
   dedicated build account with Edit App Metadata and Publish App Changes
   permissions; authenticate it interactively first, including Steam Guard.
   SteamCMD authentication is separate from the connector's publisher key.
3. Create an app-build VDF referencing the game's content and depot mappings.
   Leave `SetLive` empty to upload without changing any branch. Use SteamPipe's
   `Preview` option to verify mappings before uploading.
4. Run SteamCMD on that authenticated runner (replace the example values):

   ```sh
   steamcmd +login BUILD_ACCOUNT +run_app_build /absolute/path/app_build.vdf +quit
   ```

   SteamCMD may prompt for login/Steam Guard if its cached session has expired.
   Uploading is a separate CLI operation, not an HTTP tool in this integration.
5. Call `list_builds` with the app ID and identify the uploaded build. Call
   `set_build_live` with `appid`, `buildid` and an explicit beta branch name.
6. Call `list_branches` to verify the selected branch's build.
7. For a released app's public branch, use `betakey: "public"` and the confirming
   account's `steamid` as a string. HTTP **201** means **awaiting Steam Mobile
   confirmation**, even when the connector reports HTTP-level `success: true`.
   Confirm in Steam Mobile, then verify the branch again before reporting it live.

App creation/store metadata, review submission, pricing and the first store
release remain Steamworks dashboard operations. Build promotion does not replace
Valve review or release a new store listing.

## Official references

- https://partner.steamgames.com/doc/webapi/ISteamApps
- https://partner.steamgames.com/doc/webapi_overview
- https://partner.steamgames.com/doc/sdk/uploading
- https://partner.steamgames.com/doc/store/releasing

Contract checked against the official documentation on 2026-09-07. Automated
tests use mocked Steam responses; a publisher account is needed for live checks.
