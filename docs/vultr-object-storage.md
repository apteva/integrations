# Vultr Object Storage

Catalog: `src/apps/vultr-object-storage.json` (slug `vultr-object-storage`).

In Vultr Console, open Cloud Storage > Object Storage > your subscription >
Overview > S3 Credentials. Configure:

- `s3_hostname`: the assigned hostname only, such as `ewr1.vultrobjects.com`.
- `access_key_id`: the subscription's `s3_access_key`.
- `secret_access_key`: the subscription's `s3_secret_key`.
- `region`: defaults to `us-east-1`; Vultr documents that region is ignored.

The existing `vultr` integration can retrieve these details through
`object_storage_get`. Its management API bearer token cannot authenticate S3
requests.

Available tools: `list_buckets`, `create_bucket`, `delete_bucket`,
`list_objects`, `put_object`, `get_object`, and `delete_object`.
`list_objects` always uses ListObjectsV2 and accepts pagination tokens.
`put_object` sends plain text verbatim or decodes a runtime binary envelope;
blob references must be rehydrated by the calling runtime. Text uploads use
`text/plain`; binary envelopes supply their MIME type. Multipart uploads and
version-specific deletion are not included. Deleting an object in a versioned
bucket creates a delete marker. Buckets must be empty before deletion.

Validation: mocked executor tests cover hostname interpolation, SigV4 credential
scope and payload hashes, pagination, upload bytes, binary downloads, and bucket
operations. No live authenticated Vultr requests were made.

Provider references checked September 13, 2026:

- https://docs.vultr.com/products/storage/object-storage/management/manage-credentials
- https://docs.vultr.com/products/storage/object-storage/s3-compatibility-matrix
- https://docs.vultr.com/how-to-use-s3cmd-with-vultr-object-storage
