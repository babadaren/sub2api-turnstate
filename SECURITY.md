# Security

Use HTTPS for public administration. Keep both application listeners on loopback.
The dashboard Nginx configuration must erase `X-Turnstate-Control` from inbound requests.
Protect `/var/lib/sub2api-turnstate` and `/etc/sub2api-turnstate`; never commit runtime files.

Passwords are scrypt hashes. State blobs are stored as sensitive plaintext with mode 0600,
not encrypted at rest. Audit records contain fingerprints/lengths, never full state or credentials.
Full state reveal and manual pin require an authenticated POST and CSRF token (or a root-owned
local control token). Delete the initial password recovery file after saving it securely.

Length matching is not validity verification. Scope isolation uses a salted HMAC of the
client credential, model, and optional session/turn. It does not identify the account chosen
inside Sub2API. Pinning must be explicitly enabled and may cause routing errors on pooled accounts.
Fresh installations start disabled. Existing pin-mode installs migrate to automatic mode.
Unknown models do not inherit astra's length. Automatic probing can keep incurring costs
while a connected target request waits; there is no hourly quota or total retry limit in v0.5.
The authenticated start/stop control is authorization for that automatic processing.
Pacing, bounded in-memory waiters, individual socket timeouts and explicit auth/rate-limit
errors remain. In v0.6, renewal credentials can remain in bounded process memory as described below; they are never persisted to disk or exposed in snapshots.

TLS/DNS setup never exposes login in plaintext while waiting for a certificate. Avoid broad
proxy retries: an already accepted generation must not be replayed to the backup server.


## v0.6.0 proactive renewal
Allowlisted authentication and routing identifiers are retained only in bounded process memory (at most 128 binding slots) after a qualified binding is seen. This enables unattended renewal even with no new foreground request. These values never enter logs, status snapshots, files or a release package. Stop, shutdown, configuration change and slot eviction clear their references; immutable JavaScript strings cannot be guaranteed cryptographically zeroized. On restart the operator must send a normal target request to re-arm the plan. Renewal probes may be billed while the switch remains enabled. Identical old states never extend the configured expiry. In v0.7.0, model equality is intentionally not enforced; a different response model can qualify by length plus successful completion, but is never claimed to prove requested-model identity.


## v0.7.0 acceptance
The administrator requested length-only model selection. Any response model, including luna or a missing model name, can qualify if successful completion and a single safe target-length header are present. This policy is NOT a model authenticity guarantee. Actual response model values remain visible; there is no response-body model rewriting and no sharing across requested-model bindings. Per-model disable/delete uses authenticated CSRF-protected POST and clears only that model's pins and memory-held routing identity.


## v0.8.0 model-wide cache and editable TTL
New rules default to 3600 seconds and model-wide sharing; old persisted rules retain their scope unless the operator explicitly migrates them. In model scope, the salted binding hash contains only the requested model, not tenant/credential/session identity. This intentionally removes those state-isolation boundaries and is not suitable for unrelated upstream accounts or untrusted multi-tenancy. Original requests always retain their own credentials and Sub2API performs authorization. Cross-account compatibility remains unverified. Credential/session/turn scopes are still available.
Only successful probes or completed original responses can supply model-wide renewal credentials. Anonymous calls cannot create model bindings; failed credentials do not replace remembered renewal credentials or revoke a state acquired by another credential merely because of HTTP 401/403. The normal unknown-error preservation policy remains. No routing credential is printed or stored on disk. A TTL-only edit reuses the source acquisition timestamp, and explicit scope widening never extends the prior expiry. TTL is a local operator limit, not verified upstream validity.
