---
name: firecrawl-complexelite
description: Use when integrating the Complex Elite self-hosted Firecrawl service into this Tools Platform or another signed-in Complex Elite app.
metadata:
  author: Complex Elite Media Group
  version: "1.0.0"
---

# Complex Elite Firecrawl integration

## Service and authentication

- The staff UI is `https://tools.complexelite.com/firecrawl`.
- The API base is `https://tools.complexelite.com/firecrawl/v2`.
- In a browser UI on the Tools origin, call the same-origin `/firecrawl/v2/...` paths with `credentials: 'same-origin'`. The Tools gateway validates the Perfex staff session and forwards the request. Do not add an API key or expose `TOOLS_API_SECRET` to browser code.
- Trusted server-to-server clients may use the gateway's timestamped HMAC contract: `X-CE-Timestamp` is Unix seconds; `X-CE-Signature` is lowercase HMAC-SHA256 over `${timestamp}\n${method}\n${path}` with `TOOLS_API_SECRET`. The signed path includes `/firecrawl`.
- Firecrawl itself has no public listener. Keep all requests on the protected Tools gateway; do not publish the internal API, browser, database, Redis, or RabbitMQ ports.

## Available operations

- `POST /scrape` — one known URL.
- `POST /search` — discover web pages from a query.
- `POST /crawl` — start an asynchronous crawl; poll `GET /crawl/{id}` and use `DELETE /crawl/{id}` to cancel.
- `POST /map` — discover URLs on a site.

Use API v2 request and response schemas from Firecrawl's official API documentation. Keep crawler limits conservative for the VPS and display returned content as text unless it has been explicitly sanitized; never insert scraped HTML into the application DOM.

## Data handling

- Do not persist scraped page content unless the user explicitly asks for persistence and the storage location and retention are clear.
- Avoid logging request bodies, scraped content, credentials, or signatures.
- Validate user-supplied URLs as HTTP or HTTPS. Continue to enforce the existing session/HMAC authorization and same-origin check at the gateway.
