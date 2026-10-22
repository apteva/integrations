# Clouding.io and UpCloud

Clouding's API uses `X-API-KEY` and UpCloud uses bearer API tokens. Credentials stay in the connection store. Never send a private SSH key to either provider.

Clouding: https://api.clouding.io/docs/ (OpenAPI: https://api.clouding.io/docs/clouding-io-openapi-v1.yaml).
The catalog covers server lifecycle, flavor and volume-size catalogs, images, SSH keys, firewalls, snapshots, backups, VPCs and actions. Lists use `page` and `pageSize`; `links.next` indicates more results. Server creation must attach an existing public firewall. The optional public `firewall_id` connection setting selects one; Instances may otherwise discover an existing SSH-enabled firewall without changing its rules. Flavor prices exclude disks and image licenses.

UpCloud: https://developers.upcloud.com/1.3/ and https://upcloud.com/docs/tooling/api/.
The catalog covers server lifecycle, plans/zones/prices, Linux templates, block-storage lifecycle, backups, networks and firewall rules. Requests preserve the API's named envelopes (`server`, `storage`, `storage_device`). Deletion requires a stopped server. The `storages` query parameter defaults to retaining storage; deleting a server does not implicitly authorize deletion of unrelated attached disks.

These definitions are discovered automatically from `src/apps`. A Server must refresh its integration catalog to discover them. They do not install a provider connection, allocate a server or change existing hosts.
