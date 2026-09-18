# v0.2.0 validation

Executed in an isolated Linux development environment with Node.js 22.16.0 and Nginx.

- `npm run check`: passed.
- `npm test`: 24 tests passed, 0 failed, 0 skipped at this stage.
- Includes real Nginx route rewrite, fallback on refused connection, no POST replay on 502, takeover rollback and disconnect.
- New cases cover distinct per-model lengths (synthetic 280-byte test fixture for sol, NOT a claim about the real model), credentials/session separation, exact JSON model handling, unknown-model pass-through, refresh without a probe, timer expiry, stale in-flight responses, persistence and protected reveal.
- Existing transport tests cover 2 MiB body pass-through, auth preservation, environment proxy isolation, SSE and WebSocket handshakes.

These tests do not establish that 292/312 or any other length is accepted by a real upstream.
No real upstream credential or paid generation is used by the tests. Production installation and
TLS verification are separate deployment steps, not implied by these unit/integration results.

## Linux deployment verification — 2026-09-18

The tagged v0.2.0 source was also tested on Ubuntu 20.04 using the deployed
Node.js 22.23.2 runtime and the host's Nginx 1.18.0. Tests used temporary
directories, mock upstreams, high loopback ports and the unprivileged service
account; they did not replace the production Nginx configuration.

- `npm run check`: passed.
- `npm test`: **24 passed, 0 failed, 0 skipped** on this environment as well.
- Public HTTPS health/version check and administrator login: passed.
- Anonymous status, model state and full-state reveal requests: rejected.
- Session cookie Secure / HttpOnly / SameSite flags: checked.
- State-changing requests without CSRF or with a foreign Origin: rejected.
- Console stop-processing kept the daemon available; original observation mode
  was restored immediately after that check.
- Logout invalidated the session; subsequent model-state access was rejected.
- Nginx configuration validation, systemd enabled/active state, original
  Sub2API health and existing outbound proxy listeners: checked.
- The console received a dedicated TLS certificate and renewal reload hook.

No paid generation, real upstream account change or raw state replacement was
performed by these deployment checks. The deployment remained in `observe`
mode. Successful tests do not prove that a particular state length is valid
for a real upstream, and an empty fixed-state list is not a successful refresh.
