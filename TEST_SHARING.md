# v0.8.0 — editable lifetime and model-wide shared states

## Changes

New rules default to 3600 seconds and `scope: model`. The dashboard now edits `ttlSeconds` (integer 30..86400) and scope. `model` ignores session and client-key differences for the cache key. It is explicitly a model-wide state-sharing policy, not upstream account isolation. Credential/session/turn remain available.

Concurrent requests for the same model join one discovery task. They share the accepted opaque state, not the original request's credentials, prompt, routing fields or response body. Different requested models remain separate. The existing single switch, per-model disable/delete, length-based acceptance, twenty-row pagination and early-renewal scheduler remain.

TTL-only edits keep qualified live state and calculate expiry from the original capture timestamp. Widening an existing rule to model scope keeps the newest qualified, non-expired state and never extends its previous expiry. In-memory renewal plans are rebound where their pin remains valid. Disabled/deleted or incompatible scopes still cancel only the affected model.

Shared renewal authentication is accepted only after successful probe/response completion. An unverified cache-hit credential cannot replace an established background credential. A different caller's 401/403 does not invalidate the captured source caller's pin, and probe-auth cooldowns do not block unrelated client keys.

## Verification performed in this release task

Windows: existing full regression set (123 tests, 122 passed, one real-Nginx test skipped), plus the 13 new sharing tests all passed independently. Final complete Linux regression: **136 passed, zero failed, zero skipped**.

Linux tests ran on the owned ipxair host under the service's unprivileged account using Node 22.23.2 and actual Nginx, in `/tmp/turnstate-sharing080.2Ll3h2`. Test duration was approximately 6.7 seconds. The tests use isolated loopback mock upstreams, synthetic keys, synthetic state values and virtual clocks. They are not a paid provider benchmark.

The 13 added cases cover:
- 3600/model defaults, all supported scopes and no anonymous cache binding.
- Six concurrent sessions using different keys: exactly one probe, six original requests, preserved per-request auth/bytes.
- Separate requested models still have separate jobs/pins.
- API creation defaults, editable 30..86400 lifetime, invalid values rejected, delivered form fields.
- TTL edit preserving fingerprint, acquisition time and armed renewal; expiry recomputed from capture time.
- Shortened lifetimes never serving already-expired state.
- Explicit session-to-model merge keeping newest live state without expiry extension.
- Expired bindings never resurrected by scope migration.
- One cancelled shared waiter not cancelling the other waiters' task.
- Invalid caller unable to replace renewal credentials or invalidate another caller's cached state merely by authentication failure.
- Probe auth cooldown isolated to the rejected caller.
- One proactive renewal per model; other sessions continue with valid old state until replacement.
- Preserved shared pin re-armed by a successful original response, not an unverified cache hit.

## Operational limits

A task can make multiple length-miss attempts before it succeeds; model sharing means one task, not a promise that the first network probe always succeeds. Existing waiter/byte/concurrency safeguards still apply. Route-state lifetime and cross-account compatibility cannot be verified from byte length. Model sharing across unrelated upstream accounts may be unsuitable; use finer scopes there.

`deploy/migrate-model-sharing.mjs` is an explicit offline tool (dry-run unless `--apply`) and is not an npm postinstall hook. It preserves enabled flags and target lengths, changes old scope to model and old default 300 seconds to 3600, and retains other custom TTLs. Stop and back up the service before applying. Publication/deployment are separately checked; this test report does not claim a full real-hour production renewal cycle.
