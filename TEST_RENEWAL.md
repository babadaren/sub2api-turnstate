# v0.6.0 proactive renewal verification

Verification performed on 2026-09-19. This report records tests, not a claim that the production upstream always provides a fresh 292-byte state.

## Test runs

- Local Windows: `npm run check` passed. `npm test`: 72 tests, 71 pass, 0 fail, 1 skipped (Linux Nginx integration).
- ipxair isolated Linux directory `/tmp/turnstate-renewal060.mdqn7L`: syntax checks passed; 72 tests, 72 pass, 0 fail, 0 skipped, under the existing Node 22 runtime and Nginx. Tests ran as the unprivileged `sub2api-turnstate` user against loopback mock upstreams, not the live model service.
- No real model generation was triggered by these tests. Time-based cases use virtual clocks plus a separate real interval-timer regression; this is not a one-hour production soak test.

## Coverage

One-hour state starts renewal at age 50 minutes; short lifetimes use one-third of lifetime as lead time, capped at ten minutes. The timer starts without a new request once memory-only routing is armed. Old unexpired state serves foreground requests while a separate renewal runs. A new matching state atomically replaces the binding and is persisted. Wrong model, wrong length and identical old state do not extend the old expiry. Expired foreground requests join an ongoing renewal rather than launch another one.

Disabling cancels work, clears retained routing and prevents late adoption. Restart does not restore API keys: one normal matching request re-arms the preserved pin. Network/rate-limit errors retain the old value and respect Retry-After; authentication rejection requires new foreground routing. Keys, session identities and prompts do not appear in snapshots or persisted files. Original requests are never replayed by the extension.

## Old-state rollback regression completed in this retry

The original late-response protection compares the pin used at request dispatch with the current stored pin. Additional protection now refuses to replace a qualified live pin from an ordinary response, even when that ordinary request was sent AFTER renewal. Only the independent renewal job may rotate a qualified live pin.

The HTTP regression sends A, installs B while the first request is in flight, receives A in that old response, then sends B while the upstream again echoes A. It checks that subsequent requests still use B, the stored object remains B, and B's expiry is unchanged.

## Deployment boundaries

Existing model rules, local TTL, scope, state and the single enabled/disabled switch are preserved. No Docker network, Sub2API account selection, outbound proxy or credential-file changes are required. The extra authentication retention is in bounded process memory only; shutdown/disable removes references, and a process restart waits for one normal matching request to re-arm timer renewal.

Model/length/TTL checks do not prove actual underlying model identity or upstream cryptographic expiry. If upstream never issues a new matching value before expiry, uninterrupted operation cannot be guaranteed. Probe charges can continue while enabled. Publication and deployment outcomes are recorded separately by the upgrade/verification run.
