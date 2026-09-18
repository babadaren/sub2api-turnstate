# Changelog

## 0.2.0

- Configurable per-model pin/discard lengths, optional response-only candidate learning, refresh intervals and scope.
- Never assume unknown models use astra's 292-byte preset.
- Authenticated rule editor, observations, masked candidate/pin cards, countdown, explicit full-value reveal and manual scoped replacement.
- Manual/TTL invalidation waits for a subsequent real successful response; does not send paid probes.
- Stale in-flight responses cannot undo manual refresh/rule edits.
- Preserve API keys, request/response bytes, SSE, WS transport and existing Sub2API egress proxies.
- Private runtime CLI wrapper, systemd installation, reversible Nginx takeover and DNS-pending HTTPS activation command.
- Default remains observe; cross-turn/account compatibility pinning is explicitly experimental.
