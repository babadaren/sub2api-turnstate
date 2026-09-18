# v0.3.0 active probe verification

Date: 2026-09-18.

## Executed tests

- Windows development runtime Node 22.19.0: syntax checks passed; 44 tests passed, one real-Nginx integration test skipped because Nginx is not installed there.
- Ubuntu 20.04 target-host environment, private Node 22.23.2 and Nginx 1.18.0: syntax checks passed; **45 tests passed, 0 failed, 0 skipped** (including nested tests).
- Target-host tests ran in a temporary directory, as the unprivileged extension service user, against mock upstreams on ephemeral loopback ports. They did not use real upstream credentials or issue paid model generations.

## Covered cases

- A serial 312-length miss followed by a 292-length hit stops and records a pin for the exact requested model/API-key/session binding.
- A luna response cannot seed astra even if it supplies a 292-byte header.
- Missing response model, failed response events, duplicate/unsupported state values and stale rule epochs do not create a matching probe pin.
- A response ended specifically by the requested output token cap is distinguished from a failed response; pinning is a compatibility rule, not a full generation or validity guarantee.
- Explicit billing/experimental confirmation, attempt caps, cooldown, hourly quota, exact binding selection and cancellation are enforced.
- No loops on 401/403/429/5xx, no redirected credentials, no retries of ambiguous transport failures.
- Borrowing a future request only starts after the selected matching successful request; other model/credential bindings cannot trigger it.
- No original prompt, session identifier, raw API key or full state in probe summaries or forwarding journals. State snapshots remain protected by the existing private state-store policy.
- Requested/forwarded/response-declared models are logged separately, while original request and streaming response bytes are preserved.
- Existing SSE, WebSocket, Nginx alias/rewrite/fallback, reversible deployment, auth and CSRF regressions passed.

## Not established by these tests

These results do not establish that the real upstream will produce 292 on this egress, that any specific length is valid, or that session-scoped state remains usable after a Sub2API internal account change. No active scan is automatically armed by installation or upgrade. An operator must explicitly start a bounded scan in the authenticated console.
