# Complex Elite Tools Platform

Private Perfex-staff runtime pages for HyperFrames and FFmpeg at `tools.complexelite.com/hyperframes` and `/ffmpeg`.

- HyperFrames is pinned to the official `0.8.226` CLI release, sourced from the [upstream project](https://github.com/heygen-com/hyperframes).
- FFmpeg is compiled from [upstream FFmpeg](https://github.com/FFmpeg/FFmpeg) at commit `aab6cec3e8415154b3f0570f8d131db07a9901de`. The build disables network protocols and provides a static CLI binary.
- No database is needed; these are stateless runtimes and read-only status pages.
- The browser pages use Perfex's one-time staff SSO handoff. Set `PERFEX_SSO_EXCHANGE_URL` and `STUDIO_SSO_SECRET` in Dokploy; the secret must match the Perfex/Studio integration.
- A server-to-server runtime probe is available at `GET /api/v1/runtime/{hyperframes|ffmpeg}`. Authenticate with `X-CE-Timestamp` (Unix seconds) and `X-CE-Signature`, the lowercase hex HMAC-SHA256 of `${timestamp}\nGET\n${path}` using `TOOLS_API_SECRET`. Keep the secret in Dokploy and client server environments only. This endpoint only returns a fixed version probe; it does not execute caller-supplied commands.
- FFmpeg and HyperFrames binaries are installed in this app's container and are available to future app workflows through reviewed service endpoints. No public shell, arbitrary command, media-upload, or job execution endpoint is exposed.

The platform serves informational runtime pages; it does not create render projects by itself. A future render/job API must define per-user authorization, storage ownership, bounded inputs, resource limits, and timeout/retry handling before execution is enabled.
