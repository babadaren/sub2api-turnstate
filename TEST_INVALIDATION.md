# v0.6.2 — Evidence-based pin invalidation

## Regression and purpose

The previous online diagnosis found one scheduled renewal followed approximately 11 minutes later by a discovery, not two duplicate renewal timers. Two HTTP-200 SSE failures had revoked the new pin despite an unchanged response model. Historical logs lacked the underlying error code, so the exact real upstream failure remains unknown.

This release fixes the reproduced overbroad policy: ordinary generation failure alone no longer revokes a qualified, unexpired state or resets its renewal timer. It also makes subsequent real failures diagnosable without retaining free-form error messages.

## Completed tests

- Windows / Node: 108 tests, 107 passed, 1 skipped (real Nginx not installed), 0 failed.
- ipxair isolated temporary directory / Node 22.23.2 / existing Nginx 1.18.0: **108 tests passed, 0 failed, 0 skipped**.
- Linux test directory (server clock 2026-09-19): `/tmp/turnstate-invalidation062.oD9fdC`.
- All model responses in these tests came from loopback mock servers with synthetic credentials and states. No production API key or paid model call was used to test this change.

The new regression file includes 26 tests/subtests covering:

1. Same-model generic `response.failed`, flat SSE `error`, context/quota failures and incomplete responses preserve the exact pin, expiry and renewal schedule. A subsequent request sends no probe. The error response is unchanged and counted as a failure, including HTTP 200 SSE errors.
2. Generic HTTP 400/409/429/500/503 retain pins. A 409 alone no longer claims a state error.
3. Explicit structured state rejection invalidates once; the next request discovers one replacement. The invalidation event links to the triggering request record and records the old expiry.
4. HTTP 401/403 keep the existing conservative authentication invalidation policy. Model mismatch and conflicting model declarations also remain invalidation evidence.
5. Concurrent rejection of the same pin emits one actual invalidation. A late response using an older pin cannot invalidate its replacement.
6. A structured SSE rejection can be recognized before EOF; switching processing off suppresses late mutation.
7. Only finite, allowlisted code/type/parameter categories are recorded. Unknown fields become `other`; error messages, raw states, credentials and prompts do not enter the new logs.

Existing renewal, privacy, streaming, concurrent binding isolation, login/CSRF, real Nginx rollback/fallback and 20-record pagination regressions remain passing.

## Scope and limits

The state-error aliases in `lib/failure-policy.mjs` are a narrow **local compatibility policy**, not an authenticated catalogue of provider error codes. Unknown failures default to retaining the pin and recording a safe category for investigation. This does not prove every retained state is valid. Expiry, manual refresh, explicit state rejection, authentication rejection and model mismatch still allow necessary discovery.

The automatic timer, per-model rules, state length targets, one-hour configured TTL, 10-minute lead, gateway routing and egress proxy settings are not changed. Additional fields explain discovery triggers; there is no extra task or retry quota. Original user generations are never replayed by this change.

Deployment uses a separately versioned release, package checksum validation, a service-user readability check, a drain of existing streams, preserved rules/pins/expiry and health-checked Nginx reconnection. Rollback copies remain available. Restart necessarily clears memory-only renewal credentials; the next ordinary matching request re-arms the unchanged schedule.
