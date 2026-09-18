# v0.3.1 metadata diagnostics validation

## Reproduced defects

The v0.3.0 ingress stopped JSON model inspection at 1 MiB. Successful requests around 1.3–1.4 MB were forwarded correctly but recorded with a null model. The normal response observer also stopped at 64 KiB, so a large first SSE event could hide a model declaration even though the transport succeeded. An empty diagnostic field did not establish a model switch.

## Fix

- Default request inspection: 8 MiB, configurable and bounded.
- Default normal response inspection: 4 MiB, configurable and bounded.
- Four concurrent readers in each direction by default; total configured byte-budget validation. These are not exact process RSS limits.
- Explicit reasons for size, compression, concurrency, missing/invalid JSON model, response scan limit, and WebSocket handshake cases.
- UTF-8 decoding survives split multibyte characters.
- Response completion/failure flags and validated upstream request IDs enable correlation without retaining prompts, answers, authentication headers or full state values in logs.
- Existing model pin lengths, discard lengths, lifecycle/scope, egress proxy and active-probe budgets are unchanged. No paid probe is automatically started.

## Executed tests

2026-09-18, Windows Node 22.19.0: 49 passed, 0 failed, 1 skipped (Nginx unavailable).

2026-09-18, isolated tests on Ubuntu 20.04 / Node 22.23.2 / Nginx 1.18.0: **50 passed, 0 failed, 0 skipped**. Temporary directories, mock upstreams, ephemeral loopback listeners and the unprivileged service account were used. These tests did not invoke a real model provider.

Coverage includes exact model recognition after a 1.4 MiB field, SSE events larger than 64 KiB, unchanged body/credential forwarding, 9 MiB bypass, custom limits, gzip bypass, malformed/missing model reasons, bounded concurrency, SSE streaming, WebSocket passthrough, probe safeguards, Nginx routing/fallback/recovery and secret-free logs.

Passing tests does not prove 292 is valid, 312 is invalid, or that the upstream will ever issue a requested length. Probe success and actual live model completion require separate evidence.
