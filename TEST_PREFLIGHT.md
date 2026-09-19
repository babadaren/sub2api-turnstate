# v0.4.0 request-time preflight validation

## Executed checks

- Windows development Node 22.19.0: syntax checks passed; 70 tests passed, zero failed, one real-Nginx test skipped because Windows has no /usr/sbin/nginx.
- Ubuntu 20.04 deployment host, Node 22.23.2 and Nginx 1.18.0, unprivileged isolated fixtures: final suite **71 passed, zero failed, zero skipped**, duration 12.48 seconds.
- An initial Linux run exposed a fixture using session_id without enabling underscores in its isolated Nginx. The fixture was corrected to use the supported session-id alias; the final test exercises an actual probe and a strict 503, not just a missing-identity rejection.

## New paths verified

Original requests retain their bytes/path/authorization and are sent exactly once after a qualifying hit. A 312 miss followed by a 292 hit produces two tiny probes followed by one original; the next same-binding request uses the verified cache with no additional probe. Target lengths come from per-model rules.

Exhaustion blocks the original in strict mode, maximum attempts includes the first attempt, and failure cooldown prevents an immediate additional batch. A mismatched model even with a 292 header does not qualify. Explicit fallback preserves original request/response headers without applying state filters. Same-binding concurrent requests share a single job; separate credentials do not share pins. Expired/unverified state cannot skip probing.

Authentication/rate-limit/server errors stop without repeated probes. A real generation error after a successful preflight is not retried. Client disconnect cancels pending work and never sends its original body. Disabling pin mode during a wait cancels the probe and restores passthrough. Total deadline is enforced. Shared attempt budget is persisted; excessive hourly use is rejected before any outbound request. Admin authentication, CSRF, billable opt-in and configuration bounds were tested.

The real Nginx test proves an intentional gate HTTP 503 does not trigger backup forwarding. The mock origin receives one probe, not the original. Existing routing, alias rewrite, refused-port fallback, SSE, WebSocket transport, metadata inspection, login and state tests remain covered.

## Production scope and limits

This release does not enable automatic preflight on upgrade, start a real billable probe, alter existing pin/rule settings, change Sub2API account selection, change the 172.18.0.1:1081 proxy, or prove the current upstream can issue any 292 token. All generation tests use local mock upstreams and synthetic states.

Successful model/length/TTL checks are necessary local acceptance conditions, not cryptographic verification or proof of the actual underlying model. The latest real probe observed before this work returned model_mismatch (requested astra, declared luna, length 312). A strict gate will fail closed for that result. Unknown/unparseable models and WebSocket handshakes are outside gate coverage. See deploy/PREFLIGHT.md for operational details.
