# v0.4.1 validation — 2026-09-19

## Observed production issue (read before changes)

The installed v0.4.0 reported a completed manual probe with maxAttempts=10,
tried=1, status=model_mismatch, HTTP 200, state length 312, requested model
`gpt-6-astra`, and response-declared model `gpt-5.6-luna`. The request-time
preflight rule was disabled. No credentials or raw states are included here.

## Executed tests

- Windows development runtime: syntax checks passed; 75 tests passed, 0 failed,
  1 skipped (real Linux Nginx integration).
- Ubuntu 20.04 / Node 22.23.2 / Nginx 1.18 server environment, temporary test
  directory, loopback mock origins and unprivileged service user: syntax
  checks passed; **76 tests passed, 0 failed, 0 skipped**.
- Both manual probing and HTTP preflight were configured above ten attempts.
  Eleven synthetic successful HTTP responses declared luna; the twelfth
  declared astra and carried a 292-byte fixture. Both paths retried to attempt
  twelve and only then accepted the candidate. The preflight original body
  was forwarded once, after the successful probe, never during the misses.
- A wrong-model response with a matching 292 length never produced a pin.
- Repeated model mismatches exhausted the requested count rather than silently
  ending after one attempt. Cancel during retry interval sent no further probe.
- Existing auth/429/5xx, timeout, cancellation, body preservation, SSE,
  single-flight waiting, no original POST replay and Nginx tests still passed.
- The new budget endpoint required authentication, Origin/CSRF protection and
  explicit billable acknowledgement. Raising a quota above 30 retained usage;
  reloading the manager retained both the configured limit and usage.

## Limits and interpretation

Attempts are positive safe integers, not hard-capped at ten. Total time and
shared rolling-hour budget still apply. Default hourly budget remains 30 until
an administrator explicitly changes it. Changing limits does not clear usage.
Manual attempt summaries retain only the latest 100 records; aggregate counts
and the bounded audit log remain available.

All generation/probe tests used mock upstreams and synthetic states. These
results do not prove a real upstream will issue 292, that repeated sampling
changes upstream routing, or that a candidate identifies the underlying model.
The update does not modify Sub2API account/proxy settings or automatically
start a billable job. Production deployment health checks are separate from
these integration tests.
