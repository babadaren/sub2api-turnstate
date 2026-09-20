# v0.9.0 proxy-pool preview verification

## Implemented

Optional probe-only proxy pool with authenticated node CRUD/import/order controls, encrypted secret persistence, HTTP CONNECT / HTTPS CONNECT / SOCKS5 username-password tunnelling, persistent next-node cursor, one-round fallback to existing Sub2API probing, and per-attempt/accepted-state route provenance. No changes to Sub2API source, account proxy configuration, database, or original generation egress.

Direct provider probing requires an explicitly configured source token and (for Codex OAuth) ChatGPT account ID. The administrator also binds the one local client key authorized to trigger that source; other callers retain the local Sub2API route. The node's proxy username/password are not provider credentials. No automatic database extraction, OAuth refresh or API-key substitution is implemented. Without source credentials, node CRUD and a non-model connectivity check work, but the switch refuses activation. This is intentional and visible, not a claim of completed upstream integration.

## Automated tests

Windows: 164 tests, 163 pass, 1 skip (real Nginx unavailable), zero failures.

ipxair isolated suite: 164 tests, all pass, zero skipped or failed. Directory `/tmp/turnstate-proxy090.TCFu5s`. The existing 136 tests remain; 28 new tests/subtests cover import formats, CRUD/order, encryption and redaction, missing-source refusal, unauthorized-caller default route, cursor/reload, eight-node wrap and fallback, shutdown/cancellation, upstream auth/rate-limit stopping, proxy auth failure, separate HTTP/SOCKS handshakes including fragmented replies, and authenticated management/CSRF. Ring/acceptance tests use synthetic upstream responses and credentials.

## Network check performed

One real HTTP CONNECT proxy was supplied by the operator and tested with TLS certificate validation against Cloudflare's public trace endpoint. The result reported a public US exit and HTTP connectivity success. No model endpoint or provider credential was used. The private endpoint, username and password are not included in this public report/package.

No real 292 acquisition via that proxy, cross-egress compatibility test, or actual provider OAuth authentication has been verified by this release. Provider models/names are not authenticated by the state length. Regional IP matching does not prove cross-egress compatibility. Original model requests still use Sub2API, not the probe proxy.

## Credential handling

Node passwords and explicitly configured upstream tokens use AES-256-GCM at rest; the encryption key is derived from the application's local control key. File mode is 0600 on Linux. The permitted client key is represented by HMAC. No GET response or normal log exposes passwords, source tokens, full state, original prompts, or client keys. Protection does not extend to a host administrator who can read both local control config and the encrypted file. HTTP/SOCKS proxy authentication is not first-hop encrypted; model-service credentials are sent within validated end-to-end TLS only.

## Deployment scope

The upgrade does not activate imported-node model probing without source credentials, reset existing pinned-state expiry, modify model rules, or change global automatic on/off. Deployment and real public-domain health should be recorded separately after they have actually succeeded. The npm tarball is a GitHub release asset, not an npm-registry publication.
