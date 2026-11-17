# Mobile build integrations

The catalog contains four build-service integrations:

| Integration | Authentication | Build trigger |
| --- | --- | --- |
| `expo-eas` | Expo access token / organization robot token | Prepared Android/iOS worker job or an existing Git-backed EAS Workflow revision |
| `xcode-cloud` | App Store Connect team issuer ID, key ID, and `.p8` private key | Existing workflow plus a branch/tag or pull-request resource ID; or rebuild an existing run |
| `capawesome-cloud` | Capawesome Cloud bearer API token | Connected Git repository or an uploaded build source, with optional signing, environment, and destination references |
| `capgo-build` | Raw Capgo API key in `Authorization`, without `Bearer` | Request pending job, upload prepared native ZIP using TUS, then start compilation |

These integrations call provider APIs. They do not prepare local projects, run
`prebuild`/Capacitor sync, resolve CLI build profiles, or generate signing files.
Connect repository access and configure signing/store destinations first.

## Expo EAS

All account, project, build, and workflow operations use POST
`https://api.expo.dev/graphql`, with a fixed query and caller inputs placed under
`variables`. GraphQL `errors` in an HTTP 200 response are treated as failures
before extracting data.

For Git-backed builds, call `get_project_by_name`, then `list_workflows`, and use
a revision node ID with `start_workflow`. The committed workflow YAML determines
which builds/submissions run. Poll `get_workflow_run` and inspect its jobs.

Direct `create_android_build` / `create_ios_build` calls require the low-level
worker job used by EAS CLI: `type`, `projectArchive`, and
`projectRootDirectory`, plus any necessary signing secrets. A build-profile name
alone does not replace these inputs. A prepared archive accessible by URL can
be supplied with `projectArchive.type = "URL"`.

This is the API used by the official CLI, rather than a separately versioned REST
build API. Its GraphQL schema can evolve; update queries and job inputs alongside
the upstream CLI schema.

## Xcode Cloud

Uses the existing `app_store_connect_jwt` signer. The private key is stored as a
multiline secret and an ES256 JWT is generated at request time.

Find a product, workflow, and Git reference or pull request using the list tools.
`start_build` posts JSON:API relationship IDs to `/v1/ciBuildRuns`. Branch names
and App Store app IDs are not substitutes for these resource IDs. `rebuild`
uses the same POST route with a `buildRun` relationship. No cancellation route is
exposed because Apple's specification does not define one.

Read actions, issues, tests, and artifacts after starting a run. Downloading an
artifact explicitly disables both Apple signing and auth headers. Apple list
filters use comma-separated strings, matching `explode: false` in its spec.

## Capawesome Cloud

Uses versioned REST routes under `https://api.cloud.capawesome.io/v1`.
`start_build` supports Git refs or build-source IDs, platform/build type/stack,
signing certificates, environments, configurations, and publishing destinations.
List routes use the provider's `limit` and `offset` query parameters.

`create_build_source` accepts a source ZIP URL or a byte count for an upload
session. Finish any returned upload instructions before starting the build;
the integration does not package a local directory. Signing certificates and
store destinations must already be configured in the Console or official CLI.

## Capgo Build

Build routes are defined in the official CLI/backend source, separately from
the public OpenAPI specification for app/OTA resources. They use a raw
`Authorization` API-key header. The current build middleware does not use the
public API's newer `x-api-key` header for these routes.

1. `request_build` creates a pending job. Supply `build_credentials`, not the
   deprecated `credentials` field. `build_options.outputUploadEnabled` enables
   a temporary output download when needed.
2. `create_source_upload` sends a TUS POST with the ZIP byte length and an empty
   body. The result exposes the `Location` and `Upload-Offset` response headers.
3. `upload_source_chunk` sends raw binary bytes and `Upload-Offset`. Its binary
   envelope must use `mimeType: "application/offset+octet-stream"`. The upload
   resource is the final ZIP filename in `upload_path` from `request_build`.
   `get_source_upload_offset` uses the backend's TUS-shaped GET-to-HEAD probe.
4. After all bytes are uploaded, `start_build` begins compilation. Poll
   `get_build_status`; use `cancel_build` when needed.

For local preparation, larger uploads, or clients that do not expose response
headers, use the official `bunx @capgo/cli@latest build request` flow. Direct
`logs_url`/`logs_token` values from `start_build` require an SSE-capable client;
the deprecated proxy stream is not exposed as a generic JSON tool.

The `upload_url` in build status is a source-upload URL. Output download URLs
are emitted in completed build logs or returned by the CLI; do not confuse the
two. Artifact download tools suppress service credentials for all four providers.

## Sources and verification

Checked on 2026-10-10 against provider documentation and source:

- [Expo programmatic access](https://docs.expo.dev/accounts/programmatic-access/)
- [Expo EAS CLI GraphQL source and schema](https://github.com/expo/eas-cli/tree/main/packages/eas-cli)
- [Apple Xcode Cloud API](https://developer.apple.com/documentation/appstoreconnectapi/xcode-cloud-workflows-and-builds)
- [Apple OpenAPI specification](https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip)
- [Capawesome Cloud API](https://capawesome.io/docs/cloud/api/)
- [Capawesome OpenAPI specification](https://api.cloud.capawesome.io/openapi)
- [Capgo public OpenAPI specification](https://capgo.app/openapi.json)
- [Capgo native build CLI reference](https://capgo.app/docs/cli/reference/build/)
- [Capgo build backend](https://github.com/Cap-go/capgo.app/tree/main/supabase/functions/_backend/public/build)
- [Capgo build CLI](https://github.com/Cap-go/capgo.app/blob/main/cli/src/build/request.ts)

Expo queries were validated against the schema in its official EAS CLI.
Local executor tests cover request serialization, Apple signing, GraphQL errors,
query/body separation, TUS headers and binary bytes, and artifact auth suppression.
No account credentials were supplied and no real builds were started.
