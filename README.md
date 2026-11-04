# Complex Elite Tools Platform

Private Perfex-staff tools at `tools.complexelite.com/hyperframes`, `/ffmpeg`, and `/google-maps-scraper`.

The hostname root is a small installed-tools landing page. Each application path is explicit; unknown paths return 404 instead of falling through to another tool.

- HyperFrames is pinned to the official `0.8.226` CLI release, sourced from the [upstream project](https://github.com/heygen-com/hyperframes).
- FFmpeg is compiled from [upstream FFmpeg](https://github.com/FFmpeg/FFmpeg) at commit `aab6cec3e8415154b3f0570f8d131db07a9901de`. The build disables network protocols and provides a static CLI binary.
- `/hyperframes` runs the upstream browser editor (`hyperframes preview`) against a persistent blank composition at `/data/hyperframes/default`. The editor is protected by Perfex staff SSO, including its API, assets, and websocket traffic.
- `/ffmpeg` is a private browser converter for MP4 (MPEG-4/AAC), M4A, FLAC, and WAV, backed by the installed FFmpeg runtime.
- `/google-maps-scraper` proxies the already-running `complexelite/google-maps-scraper` service from the private Dokploy network, including its root-level static and API paths. The gateway requires a valid Perfex staff session before it proxies either the app or its API. Its running image corresponds to commit `903b96d7aa8863188022c04db220e44f3218c860` in `complexelite/google-maps-scraper`; updates to that source repo do not automatically rebuild the existing service yet.
- No database is needed. HyperFrames project files live on the Dokploy persistent volume mounted at `/data`.
- The browser pages use Perfex's one-time staff SSO handoff. Set `PERFEX_SSO_EXCHANGE_URL` and `STUDIO_SSO_SECRET` in Dokploy; the secret must match the Perfex/Studio integration.
- The conversion form accepts media uploads up to 500 MB, allows one conversion at a time, caps each output at 1 GB and 10 minutes, and deletes temporary files after download or failure. Conversion uses fixed argument lists and does not accept remote URLs or shell input.
- A server-to-server runtime probe is available at `GET /api/v1/runtime/{hyperframes|ffmpeg}`. Authenticate with `X-CE-Timestamp` (Unix seconds) and `X-CE-Signature`, the lowercase hex HMAC-SHA256 of `${timestamp}\nGET\n${path}` using `TOOLS_API_SECRET`. Keep the secret in Dokploy and client server environments only. It returns fixed version/availability information.
- The tools run in a shared runtime container. No arbitrary shell or remote URL processing is exposed. Other apps can use the authenticated conversion endpoint with supported presets; output is returned directly and not retained as a Studio resource.

HyperFrames opens its actual editor for the persistent default composition. The FFmpeg browser tool and conversion endpoint are protected by Perfex staff SSO. The Google Maps Scraper service remains managed by the existing Leads stack; its new Tools path is an authenticated gateway route, not a separate Dokploy app.
