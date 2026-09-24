# OpenStreetMap discovery

Apteva has two OSM-backed connectors:

- **OpenStreetMap Overpass** finds nearby restaurants and returns the contributor-supplied `tags` object. Configure an operator contact email. The public Overpass endpoint is the default; configure your own `/api` endpoint for frequent or dependable use.
- **OpenStreetMap Nominatim** resolves a specific place, reverses a coordinate, or looks up a known OSM ID. Configure the HTTPS base URL of a self-hosted or licensed Nominatim-compatible service.

For restaurant discovery, call `find_restaurants_nearby` with latitude, longitude and a radius up to 2 km. The response may include `website`, `contact:website`, `email`, `contact:email`, `phone`, `cuisine`, `opening_hours` and `addr:*` tags. Those fields are optional and editable by contributors. Check the official business website and independently validate contact details before outreach.

Use modest, occasional Overpass queries. Do not sweep large areas with repeated calls; use an OSM extract or your own Overpass instance for systematic collection. The public Overpass service can be busy or unavailable.

The [public Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) forbids embedding its endpoint as a generic place-search service in a general-purpose agent platform. The connector rejects `nominatim.openstreetmap.org`; the operator must provide an endpoint they run or are licensed to use. Attribute OpenStreetMap contributors when displaying OSM-derived data and follow the [ODbL license](https://www.openstreetmap.org/copyright).

The catalog tools are read-only. No OSM account or API key is required for Overpass. Live public Overpass responses can be delayed; the connector tests use mocked HTTP to verify URL construction, tags, and endpoint restrictions.
