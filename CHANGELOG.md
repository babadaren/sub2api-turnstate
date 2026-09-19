# Changelog

## 0.4.0

- Optional, default-off synchronous request-time preflight for configured models. Hold original bytes, probe a short payload, dispatch original exactly once after a qualified state hit.
- Per-model maximum attempts, total deadline, interval, failure cooldown and explicit reject/passthrough policy. Same-binding single-flight and bounded waiters/memory.
- Shared persistent hourly probe budget; cancellation on client disconnect, mode changes and rule/refresh changes. No account/egress proxy changes.
- Authenticated console settings/progress, preflight CLI controls and qualified cache metadata. Model mismatch remains a hard stop, not evidence that a length is usable.


## 0.3.1

- Fix legitimate multi-megabyte request models disappearing from diagnostics (8 MiB bounded default).
- Raise normal response inspection to 4 MiB; retain tighter active-probe budgets.
- Add configurable inspection concurrency/memory budgets and explicit missing-model reason codes.
- Record response completion/failure and validated upstream request IDs, never prompt text or credentials.
- Show missing-model reasons in the console instead of implying a model swap.
- Keep routing, model rules, length policies, outbound proxy and probe execution unchanged.


## 0.3.0

- Add administrator-confirmed, bounded active probes for an exact configured model and state length.
- Support one-shot reuse of the next successful request from an explicitly selected binding, or manual memory-only credentials. No prompt capture or durable key storage.
- Preserve Sub2API egress proxy/account configuration; no redirects, node switching or retries on auth/quota/timeout/model mismatch.
- Pin only a matching response model and target length to the exact API-key/model/session/turn binding. Stop on hit, cancel, budget exhaustion, rule change or service stop.
- Add requested/forwarded/response-declared model metadata to records; keep streaming bytes unchanged.
- Include dashboard progress, attempt history and CLI start/status/stop. Normal TTL refresh remains passive.

## 0.2.1

- Fix unversioned `/responses` and `/responses/compact` bypassing the Nginx takeover and extension records.
- Preserve the original request path, query, body, credentials, model rules and existing Sub2API outbound proxy.
- Match both `/responses` and `/v1/responses` in route classification and the generated Nginx map.
- Add alias/model logging regressions and real-Nginx unversioned route coverage. Response IDs and query strings remain absent from records.

## 0.2.0

- Configurable per-model pin/discard lengths, optional response-only candidate learning, refresh intervals and scope.
- Never assume unknown models use astra's 292-byte preset.
- Authenticated rule editor, observations, masked candidate/pin cards, countdown, explicit full-value reveal and manual scoped replacement.
- Manual/TTL invalidation waits for a subsequent real successful response; does not send paid probes.
- Stale in-flight responses cannot undo manual refresh/rule edits.
- Preserve API keys, request/response bytes, SSE, WS transport and existing Sub2API egress proxies.
- Private runtime CLI wrapper, systemd installation, reversible Nginx takeover and DNS-pending HTTPS activation command.
- Default remains observe; cross-turn/account compatibility pinning is explicitly experimental.
