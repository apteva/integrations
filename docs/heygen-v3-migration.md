# HeyGen API v3 migration

The HeyGen catalog and the server's embedded copy now use v3 for every HTTP
operation, including health checks and webhook registration. Authentication
remains `X-Api-Key`. HeyGen retires v1/v2 on November 1, 2026; migrate existing
workflows by October 31.

Existing tool names are retained where a documented v3 operation exists, but
callers must use the new input schemas. Native responses, statuses and pagination
cursors are returned without normalization. A creation response is a pending
resource, not proof that rendering or training has completed.

## Workflow changes

| Workflow | New inputs/behavior |
| --- | --- |
| Studio video | `scenes` with typed scene `input`, `aspect_ratio`, `resolution`; replaces `video_inputs` and `dimension`. |
| Transparent WebM | `avatar_id`, `script` or audio inputs; helper fixes `type: avatar` and `output_format: webm`. Requires a matting-capable avatar. Background is omitted. |
| Template generation | `POST /v3/templates/{template_id}` with `variables`. |
| Translation | Typed `video` asset input and `output_languages` array. Caption URLs are returned on translation detail. |
| Proofread SRT replacement | `PUT` with typed `srt` input (URL or uploaded asset); download returns JSON download URLs. |
| Prompt avatar | `name` and `prompt`; optionally reference/attach an existing avatar identity. |
| Photo avatar | `name` and typed `file`; attaching a look uses `avatar_group_id` and one photo per call. |
| Digital twin | `name` and typed footage `file`; consent is a separate `create_avatar_consent` call with `group_id`. |
| Avatar training/status | Training starts during creation. Poll look IDs with `get_avatar_look`/`get_photo_look_status`, or group IDs with the group status tools. |
| Upload | `upload_asset.file` takes base64 or a data URL and sends multipart, maximum 32 MB per the provider. |
| Pagination | Pass returned `next_token` as `token` on endpoints exposing cursor pagination. |
| Idempotency | Optional `idempotency_key` on documented operations becomes an `Idempotency-Key` header, never a JSON field. Provider retains keys for 24 hours. |
| Sharing | `get_sharable_url` reads `video_page_url`; it does not enable public access. |
| Quota | `get_remaining_quota` reads the native current-user resource. |
| Assets | `legacy_list_assets` keeps its name but uses `/v3/assets` and the native `type` filter. |

## Removed operations

No documented v3 equivalent exists for `list_voice_locales`,
`train_photo_avatar_group`, `add_photo_avatar_motion`, `list_folders`,
`update_folder`, `trash_folder`, or `restore_folder`.

Avatar creation starts training automatically. Configure supported avatar motion
on video creation. Folders expose only documented creation and detail operations.

## Webhooks

Auto-registration uses `/v3/webhooks/endpoints`. The server encrypts the returned
`data.secret` and saves `data.endpoint_id`. Deliveries are verified using the
`signature` header and HMAC-SHA256 of the exact raw body with the literal secret.
Invalid or missing secrets fail registration; invalid signatures fail ingress.

Existing subscriptions must be registered against v3 to obtain a v3 signing
secret and endpoint ID. A manual `rotate_webhook_signing_secret` call returns a
new secret; update the receiving subscription's HMAC secret before relying on
subsequent deliveries.

## References and validation

- [Official endpoint comparison](https://developers.heygen.com/endpoint-version-comparison)
- [Official OpenAPI contract](https://developers.heygen.com/openapi/external-api.json)
- [Webhook documentation](https://developers.heygen.com/docs/webhooks)

Local provider mocks cover request bodies, idempotency headers, binary uploads,
native responses/cursors, provider-issued webhook secret storage and signature
verification in both integration executors. Live authenticated HeyGen requests
and deployment are separate from these checks.
