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
Default installation is observe-only. Unknown models do not inherit astra's length.

TLS/DNS setup never exposes login in plaintext while waiting for a certificate. Avoid broad
proxy retries: an already accepted generation must not be replayed to the backup server.
