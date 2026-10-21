# Vultr compute and bare-metal catalog

The Vultr definition now exposes both compute catalogs (`list_plans` and
`list_metal_plans`), live `list_region_availability`, and the separate
`list_bare_metals`/`create_bare_metal`/`get_bare_metal`/`delete_bare_metal` plus
start/halt/reboot operations. Catalog and inventory lists accept cursors.

`create_instance` declares structured `block_devices` and `user_scheme` for
Vultr bootable block-storage provisioning. The existing VM endpoints and
credentials remain compatible. Bare-metal creation uses `/bare-metals` rather
than routing physical plans through `/instances`.

These are provider API primitives. Instances owns catalog normalization,
hardware/storage compatibility, availability validation, SSH initialization and
resource/boot-disk inventory. The definition does not choose hosts or purchase
resources on its own.

Existing Apteva servers can download/reload the published definition using
`POST /api/integrations/catalog/download` with the existing server bearer token.
No server binary rebuild is required. A connection continues using its existing
Vultr credentials. Publishing this definition does not refresh production.

Tests use intercepted HTTP requests to verify endpoint routing, cursor handling,
credential headers and exact boot-device JSON. No paid resources are used.

Sources: [Vultr plan client](https://github.com/vultr/govultr/blob/master/plan.go),
[bare-metal client](https://github.com/vultr/govultr/blob/master/bare_metal_server.go),
[instance client](https://github.com/vultr/govultr/blob/master/instance.go),
[VX1 boot storage](https://docs.vultr.com/vultr-vx1-cloud-compute).
