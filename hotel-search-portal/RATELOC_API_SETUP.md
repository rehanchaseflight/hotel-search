# RateLoc API setup

RateLoc is registered in the supplier connector registry as `rateloc` and the search pipeline already treats it as an API source.

## Runtime variables

Set these on the backend host; never commit values:

```env
RATELOC_API_URL=
RATELOC_API_KEY=
RATELOC_BEARER_TOKEN=
RATELOC_API_USERNAME=
```

`RATELOC_BEARER_TOKEN` takes precedence over `RATELOC_API_KEY`. `RATELOC_API_USERNAME` is sent as `x-api-username` when present.

## What is still required from RateLoc

The public RateLoc pages reviewed do not publish a developer API endpoint/schema or authentication specification for agent accounts. Before enabling live calls, obtain the official API details from RateLoc (endpoint, authentication method, request JSON, response schema, and any required hotel/city codes).

The connector is intentionally prepared for these details without storing or requesting the agent portal password in source code.

## Normalized portal output

The existing search pipeline normalizes supplier results toward:

- Hotel
- Room category
- Board basis
- Cancellation policy
- Currency
- Price
- Availability

Room/view fields are preserved when supplied by the provider payload.
