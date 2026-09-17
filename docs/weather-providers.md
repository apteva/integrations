# OpenWeather and WeatherAPI.com

Both catalogs require an API key stored in the `api_key` credential field.
The catalog loader discovers their JSON files automatically.

## OpenWeather (`openweathermap`)

Sign up at https://home.openweathermap.org/users/sign_up and copy a key from
https://home.openweathermap.org/api_keys. New keys may take time to activate.
Requests send this key as the `appid` query parameter over HTTPS.

Tools:
- `get_current_weather`: current conditions by latitude and longitude.
- `get_forecast`: 5 days at 3-hour intervals; `cnt` limits timestamps, not days.
- `geocode_location`: city or area name to coordinates.
- `reverse_geocode`: coordinates to nearby place names.
- `geocode_postcode`: postal code and country to coordinates.

Resolve cities using the dedicated geocoder; OpenWeather's built-in weather
endpoint geocoding is deprecated. Specify `units=metric` for Celsius or
`units=imperial` for Fahrenheit. Omission uses the provider's standard units
(Kelvin). The full forecast response retains city and timestamp metadata.

The published free Weather API plan includes these endpoints and allows
60 calls/minute and 1,000,000 calls/month as checked September 13, 2026.
One Call is a separate product and is not used by this integration.

## WeatherAPI.com (`weatherapi`)

Sign up at https://www.weatherapi.com/signup.aspx and copy the dashboard API
key. Requests send this key as the `key` query parameter over HTTPS.

Tools:
- `get_current_weather`: current conditions for `q`.
- `get_forecast`: daily/hourly forecast; required `days` is limited to 1–3.
- `search_locations`: resolve names or postal codes to location IDs/coordinates.

For weather requests, `q` accepts a city, coordinates, postal code, or
`id:<id>` from search results. Coordinates or IDs avoid ambiguous city names.
Responses include both metric and imperial measurements.

The published free plan includes 100,000 calls/month and 3-day forecasts as
checked September 13, 2026. Paid forecast horizons, historical data, and other
plan-dependent products are not exposed by this integration.

## Verification

Mocked executor tests cover every tool's route, query parameters, URL-encoded
credentials, response preservation, and authentication/quota errors. Tests
also check forecast schemas against provider limits. No live authenticated
requests were made; configured provider API keys are needed for those checks.
Health checks request current weather for a fixed coordinate and consume one
API call each. Provider quotas remain subject to account terms and changes.

## Sources

- https://openweathermap.org/api/current.md
- https://openweathermap.org/api/forecast5.md
- https://openweathermap.org/api/geocoding-api.md
- https://openweathermap.org/price.md
- https://www.weatherapi.com/docs/
- https://www.weatherapi.com/pricing.aspx
