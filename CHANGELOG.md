# Changelog

## 0.6.2

- Keep live pins and their renewal schedules on ordinary failed/incomplete generations, generic 409/5xx and rate limits; do not replay original requests.
- Invalidate only the pin actually used on authentication rejection, model mismatch/conflict or narrowly classified structured state rejection.
- Deduplicate invalidation events, link them to request records, and record closed-set error categories without free-form messages.
- Count HTTP-200 SSE failures as failed requests and show pin retention/invalidation and discovery triggers in the existing 20-row UI.
- Preserve all existing model rules, states, expiry timestamps and automatic renewal timing.

## 0.6.1

- Default recent request/state records to 20 per page; add previous/next, page jump and return-to-latest controls.
- Paginate the full existing recent-record retention window with server-side totals and stable anchors; retain kind/status filters and explicit legacy limit support.
- Historical pages stop polling and stay in place while status, pins and renewal monitoring keep refreshing. Expired anchors recover explicitly, and logout invalidates pending page responses.
- No changes to automatic probing, renewal, model rules or outbound proxy handling.

## 0.6.0 (local candidate; not deployed/published)

- Single-switch proactive renewal ten minutes before a one-hour local expiry, with adaptive lead for short TTLs.
- Keep the old state live until a distinct, verified replacement is available; identical state never extends expiry.
- Bounded memory-only routing identity registry, cleared on stop/restart/config change; explicit waiting-credentials UI.
- Same-binding discovery/renewal single-flight, generation-safe replacement, protection against late response rollback.
- Existing in-flight requests keep their dispatched state; new requests use the replacement.
- Renewal network errors preserve old state, back off and honor Retry-After; authentication rejection requires fresh traffic.


## 0.5.0

- Replace manual probing, separate preflight switches, retry-count/time controls and shared quotas with one authenticated start/stop switch.
- Automatic discovery on matching HTTP requests, reusing unexpired verified pins and re-probing after expiry. No batch cap, hourly quota or total task deadline; old quota files are not read.
- Wrong model/length responses retry with automatic pacing while a real request is waiting. Success dispatches the unchanged original once; client disconnect or the global switch cancels probing.
- Off is genuine transparent forwarding: no model-body inspection or late response-state rewriting. Disabling releases connected waiting originals unchanged, including stop/start races.
- Keep existing pins, per-model lengths/expiry/scope, login, Nginx routes and Sub2API outbound proxies. Old pin mode migrates to auto; old off/observe modes stay off.
- Keep resource limits, single-connection timeouts and explicit authentication/network errors. Remove obsolete manual/quota engines and API controls (410); keep the model format editor under a collapsed optional section.
- New tests cover 105 consecutive routing misses before a hit, switch/cancellation races, preserved state migration and ignored legacy quota files, plus transport/security/Nginx regressions.

## 0.4.1

- Manual and request-time probes retry successful-HTTP model mismatches as well as length misses. Exact model/length and completion checks remain mandatory for adoption.
- Remove the ten-attempt validator and HTML caps. Positive safe-integer attempt counts are supported; explicit wall-clock limits and shared hourly usage remain enforced.
- Add configurable manual run time and extend preflight wait configuration to 5–3600 seconds, with client/CDN timeout warnings.
- Add protected, persistent hourly quota configuration without clearing usage; expose remaining usage and retry progress in the console and CLI.
- Bound manual per-job attempt history to the latest 100 entries; keep totals and rotated audit records.
- Add regression scenarios that return eleven wrong models before accepting the twelfth response, plus exhaustion, cancellation, quota persistence and management authentication tests.

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
