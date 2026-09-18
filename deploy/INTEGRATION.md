# Integration boundary

v0.2.0 is an optional ingress sidecar, NOT a Sub2API source patch.
It observes exact HTTP JSON models and response headers, and offers explicitly enabled
per-model compatibility replay scoped to client credential/session/turn. It never modifies
the account's configured proxy URL. WS frames remain opaque; unknown-model WS handshakes
are not subject to model pinning.

For true multi-account isolation, a future Sub2API hook must run AFTER account selection,
with trusted internal account ID, authentication generation, model and logical turn ID.
It must use that identity for cache keys, reject spoofed client-supplied account metadata,
clear state when account/auth/turn changes, preserve the original proxyURL and timeouts,
and fail open to the unmodified original code path if the extension is unavailable.
An ingress API-key key does not provide this guarantee.

Do not claim that a fixed byte length universally proves validity, that a configured TTL is
an upstream expiry, or that invalidating a cache entry has already obtained a new state.
No billable active probes or proxy-node switching are performed by this release.
