# v0.5 migration: the separate preflight controls were removed

Use the single `turnstate start` / `turnstate stop` switch or the console button.

When started, a matching real HTTP request automatically checks its qualified pin and probes a small payload if necessary, then dispatches the original once. Model/length misses keep retrying with pacing; no maximum attempt count, shared hourly quota or total task deadline is consulted. Client disconnection cancels its wait. Stop cancels probes and releases connected pending originals unchanged.

There is no `preflight.json` to configure in v0.5. Existing `preflight.json`, `probe-limits.json` and `probe-budget.json` files are retained only for rollback and are not loaded. Old APIs report 410 rather than silently changing the new switch. Old standalone probes and quota engines are removed from the runtime package.

Existing pin-mode installations migrate to `auto`; old off/observe installations remain off. Existing model lengths/TTL/scopes, verified pins and credentials remain intact. Default fresh installation is off. Authenticated `POST /api/automation` accepts only `{"enabled":true}` or `{"enabled":false}`.

Per-connection timeouts, resource capacity guards, explicit authentication/rate-limit errors and pacing remain. They are not user-configurable retry quotas. Non-target/uninspectable/WS traffic keeps existing passthrough behavior; Nginx connection-failure fallback remains available. No production original generation is automatically replayed.

See [README](../README.md) for supported routes, privacy, single-switch operations and migration details, and [tests](../TEST_AUTOMATIC.md) for current coverage. Version 0.4 documentation is available on its Git tag.
