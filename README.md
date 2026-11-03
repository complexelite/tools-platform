# Complex Elite Tools Platform

Private Perfex-staff tools at `tools.complexelite.com/hyperframes` and `/ffmpeg`.

- HyperFrames is pinned to the official `0.8.226` CLI release, sourced from the [upstream project](https://github.com/heygen-com/hyperframes).
- FFmpeg is compiled from [upstream FFmpeg](https://github.com/FFmpeg/FFmpeg) at commit `aab6cec3e8415154b3f0570f8d131db07a9901de`. The build disables network protocols and provides a static CLI binary.
- `/hyperframes` runs the upstream browser editor (`hyperframes preview`) against a persistent blank composition at `/data/hyperframes/default`. The editor is protected by Perfex staff SSO, including its API, assets, and websocket traffic.
- `/ffmpeg` is an installed runtime information page; FFmpeg is a command-line media engine and does not ship as a standalone browser editor.
- No database is needed. HyperFrames project files live on the Dokploy persistent volume mounted at `/data`.
- The browser pages use Perfex's one-time staff SSO handoff. Set `PERFEX_SSO_EXCHANGE_URL` and `STUDIO_SSO_SECRET` in Dokploy; the secret must match the Perfex/Studio integration.
- A server-to-server runtime probe is available at `GET /api/v1/runtime/{hyperframes|ffmpeg}`. Authenticate with `X-CE-Timestamp` (Unix seconds) and `X-CE-Signature`, the lowercase hex HMAC-SHA256 of `${timestamp}\nGET\n${path}` using `TOOLS_API_SECRET`. Keep the secret in Dokploy and client server environments only. It returns fixed version/availability information.
- The tools run in a shared runtime container. No arbitrary shell, media upload, or remote FFmpeg render API is exposed; apps that need job execution require a separately reviewed, constrained media-job interface.

HyperFrames opens its actual editor for the persistent default composition. A future render/job API must define per-user authorization, storage ownership, bounded inputs, resource limits, and timeout/retry handling before remote execution is enabled.
