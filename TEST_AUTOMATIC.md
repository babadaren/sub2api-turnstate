# v0.5.0 single-switch automatic validation

Executed on 2026-09-19, with synthetic inputs, mock upstreams and isolated loopback test ports. No real user prompts, credentials or upstream generations were used in the automated tests.

## Results

- Windows / Node 22.19.0: syntax checks pass; 55 tests pass, 0 failures, 1 skipped (real Linux Nginx).
- Ubuntu 20.04 / Node 22.23.2 / Nginx 1.18.0: syntax checks pass; 56 tests pass, 0 failures, 0 skipped.

The v0.4 manual-job/quota test cases were replaced along with those retired engines, rather than left as tests of unused production behavior. Current tests run from `test/*.test.mjs`.

## Verified current behavior

- A single automatic switch activates discovery without a separate per-model preflight setting. Existing model format rules still control which models/lengths apply.
- A real local HTTP test receives a wrong model and 312, retries, obtains a matching model and 292, then sends the original exact payload once. A following matching request uses the cached state with no extra probe.
- A scheduler regression produces 105 wrong-model results before the 106th hit with no count/hourly/task-time stopping condition; fake timing is used only in this scheduler unit test. Wrong-model 292 results never qualify.
- Disabling cancels waiting probes and forwards connected pending originals unchanged, including an immediate off/on race.
- Responses arriving after an off/on generation change cannot rewrite headers or adopt new state from the old operation.
- Client disconnection cancels its wait; the unsent original is not forwarded and its held memory is released.
- Same-binding concurrent requests share one probe; distinct credentials do not share state.
- Expiry and manual invalidation cause the next matching request to probe automatically.
- A wrong-model original response invalidates the used state without repeating the user's generation.
- Old `pin` runtime migrates to auto and preserves qualified state. Off survives restart. Invalid legacy quota/preflight files do not affect the new runtime because they are not read.
- No-traffic operation performs no probes. There is no API-key entry form, manual probe API or quota configuration in the new UI; legacy admin controls return 410 after authentication.
- Anonymous access, cross-origin writes, missing CSRF and post-logout access are rejected.
- Preserved original bodies/authentication, query redaction, large-body pass-through, early SSE delivery, raw WebSocket transport, secret-free logging and configuration protections remain tested.
- Real Nginx tests cover alias rewrites, unaffected non-Codex routes, refused-connection fallback, no POST replay on 502 and no fallback forwarding of an original after an automatic admission 503.

## Boundaries

An accepted state satisfies local model-declaration, length and freshness checks only; this does not prove an upstream token's cryptographic validity or actual model identity. The ingress cannot see internal Sub2API account switches. Individual network timeouts, resource guards and error reporting remain, but no total task duration, batch count or rolling quota controls the automatic retry loop. Client/CDN disconnections can still stop a waiting request. Original requests are not retried by this extension.

The deployed service is verified separately from these isolated tests. A pre-existing qualified 292 pin, when present, is preserved instead of replaced with any synthetic test token.
