# Query parameter serialization

REST tools can opt individual array inputs into comma-separated query values:

```json
"query_param_serialization": { "metric_types": "csv", "pin_ids": "csv" }
```

Keys refer to input field names, before `query_param_aliases` is applied. Supported
modes are `csv` and `repeat`; omission retains the existing repeated-key format.
Input schemas stay arrays. Scalars are unchanged, empty arrays are omitted, and
null array items are omitted in CSV mode. Nested objects/arrays are rejected in
CSV mode. Values are joined before URL escaping, so embedded `&`, spaces and
other reserved characters cannot become additional query parameters.

The setting applies to explicit `query_params`, aliases, and implicit GET/DELETE
query inputs. It does not change JSON/form bodies or authentication parameters.
Both the TypeScript executor and Apteva's Go integration executor implement this
contract; generated MCP descriptors preserve the metadata.

Pinterest organic analytics opt `metric_types` into CSV on account, single-Pin,
bulk-Pin and top-Pin tools; bulk analytics also opts `pin_ids` into CSV. This
matches the analytics metric parameters' `explode: false` convention. Unconfigured
integrations, including repeated Google Sheets ranges, keep their behavior.

Roll out the executor support and updated Pinterest catalog before relying on
multi-metric Social reports. Deploying only Social cannot change how the older
server serializes those integration requests.
