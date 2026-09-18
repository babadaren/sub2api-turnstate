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
