# Request-time preflight (v0.4.1)

Optional admission gate for buffered HTTP POST `/responses`, `/v1/responses`, and their `/compact` aliases. Existing installs remain unchanged: this feature is OFF until an administrator enables a model, and it runs only in global `pin` mode.

## Flow

1. Extract the exact JSON model and configured credential/session/turn binding. Never infer a model from state length.
2. If that binding has a live pin matching the configured target lengths AND its response model was verified, forward the original request with that state. No extra API call.
3. Otherwise keep the original request bytes in bounded process memory. Send only a short `input: "ping"`, `instructions: "Reply only OK."`, `max_output_tokens: 16` probe to the fixed loopback Sub2API target. No original prompt, tools, attachments or old state is included. Probes can be billed; an upstream can ignore requested output caps.
4. Retry successful-HTTP length misses AND model-routing misses (`model_mismatch`), up to the configured total attempts, deadline and shared hourly budget. Accepted hits still require 2xx, exact response-declared model, target length and successful completion or an explicit output-token-limit event. A wrong-model state never qualifies even if its length is 292. Authentication errors, rate limits, redirects, timeouts, missing model identity and server errors remain terminal.
5. Adopt the scoped hit and dispatch the original request exactly once. The original path, body and authorization remain unchanged. This is not retrying the user's generation.
6. At exhaustion/error: `reject` returns HTTP 503 with `turnstate_preflight_failed` and never sends the original body. `passthrough` explicitly bypasses state rewriting and sends the unchanged original once. Neither policy fabricates a target state.

“Verified” means these local compatibility checks passed. It does NOT cryptographically verify state, prove the underlying model, or ensure a probe's state is applicable to another logical turn. The gateway cannot see Sub2API's internally selected account. Never share pins across independent upstream accounts. Prefer a tested single-account, sticky chain; a broad credential scope remains experimental. A persistent astra→luna mismatch cannot be cured just by retries.

## Configuration

Stored in `/var/lib/sub2api-turnstate/preflight.json` with owner-only permissions; editable in the authenticated console. Lengths/TTL/scope are inherited from the existing per-model rules. These settings do not overwrite those rules.

```json
{
  "gpt-6-astra": {
    "enabled": true,
    "maxAttempts": 3,
    "maxWaitSeconds": 45,
    "intervalSeconds": 2,
    "failurePolicy": "reject",
    "cooldownSeconds": 60
  }
}
```

`maxAttempts` includes the first probe: 3 means at most 1 initial call + 2 retries. It accepts positive JavaScript safe integers; there is no ten-attempt cap, and zero never means infinite. Total wait is 5–3600 seconds (default 45); interval 2–10 seconds; failure cooldown 10–600 seconds. Client/CDN timeouts can be much shorter than this configured limit; prefer separate manual jobs for lengthy sampling. Stop conditions can end before the attempt maximum. A cache hit adds no probe call. TTL is the tool's configured lifetime, not the upstream's decoded expiry.

```sh
sudo turnstate preflight-status
sudo turnstate preflight-config --file ./preflight.json --ack-billable --ack-experimental
sudo turnstate preflight-disable
```

Setting the configuration does not immediately call any model. It takes effect when a matching request arrives. Turning off global pin mode cancels waiting preflights and restores the original behavior. Changes to model rules or manual refresh cancel in-flight work. Disabling preflight does not disable the rest of the extension.

## Limits and concurrency

Same-binding requests share one preflight job. Maximum 2 different active jobs, 8 waiting original requests and 64 MiB held request bodies, in addition to existing metadata limits. Exceeding capacity applies the chosen failure policy; no unlimited queue is created. A disconnected waiter is removed; if the last waiter disconnects, its probe is aborted and its original body is never sent. A failure cooldown suppresses repeated billable batches from client retries. Cache qualification is rechecked immediately before dispatch.

Manual and automatic probes share a configurable rolling-hour quota (default 30, configurable 1–100000 via authenticated `/api/probes/budget`, the UI or `turnstate probe-budget --per-hour N --ack-billable --ack-experimental`). Limits persist in `probe-limits.json`; usage persists BEFORE dispatch in `probe-budget.json`. Increasing the limit or restarting never resets usage. Quota changes require explicit acknowledgement and no active/waiting job. A manual job blocks new automatic jobs, and automatic jobs block manual starts. Multiple independent daemon instances sharing one directory are not supported.

No credentials/prompts are written to preflight logs or configuration. Only method/path classification, model, lengths, outcome, attempts, wait time and pseudonymous binding IDs are recorded. Preflight snapshots contain no raw states. Original-request records carry `originalForwarded` and a `preflight` result. Counters and recent job snapshots reset on daemon restart; bounded journal records persist.

## Boundaries

Unknown/unparseable models, compressed or over-budget bodies, non-POST/read routes and WebSocket handshakes do not enter this gate and keep existing passthrough behavior. This is not a universal traffic firewall. Nginx connection-failure fallback also remains fail-open by design; a dead extension can route traffic directly to Sub2API. A deliberate HTTP 503 from a running strict preflight is NOT retried to the backup (covered by a real-Nginx test). Requests already sent upstream and SSE/WS streams are not replayed. Client/CDN timeouts can be shorter than the configured gateway timeout.

An old length-only or manually pasted pin is not enough for a preflight cache hit. New probes qualify exact response model; ordinary response candidates qualify when a successful, matching completion is observed. Response model conflicts disqualify them. Old/manual pins stay visible but require a verified response before they can skip preflight.
