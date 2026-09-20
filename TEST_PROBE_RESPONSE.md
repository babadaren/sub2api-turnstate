# v0.10.1: missing Content-Type and probe-pool continuation

## Incident and fix
The independent HTTPS probe received HTTP 200 and a non-target 312-byte state, but no Content-Type. The previous reader classified it as unsupported_response_type before checking the known length miss. ProxyPool did not retry that error, so only the first node ran and waiting originals received a 503 during the failure cooldown. This was not evidence that all configured nodes returned 312.

The new probe-only reader classifies non-target/duplicate/unsafe state headers as length misses after checking HTTP status, without requiring Content-Type. Target-length headers still require successful structured completion. Missing/plain/octet-stream media types are sniffed within a bounded prefix for SSE/JSON; HTML, unknown text, failed, incomplete or invalid JSON cannot qualify. gzip/deflate/Brotli decompression is bounded and must pass integrity/end checks. Normal forwarded response bytes are unchanged. Header and detection metadata are enumerated; no raw body, credential or state is added to logs.

Response format/decode failures can move to the next node of the current finite node round. All nodes exhausted uses the existing local Sub2API fallback. Explicit upstream 401/403/429 stops remain. The original request is never silently retried or bypassed. This is not a guarantee of obtaining any target state or any underlying model identity.

## Validation
Windows: 222 Node tests, 220 passed, 2 platform-only skips, 0 failures.
Linux (Node 22.23.2, server Nginx): 222 Node tests passed, 0 skipped, 0 failures; 8 Python auth exporter tests passed.
39 added tests/subtests cover missing type with 312/292, split prefixes, BOM/SSE comments, JSON, failure and incomplete events, unknown/HTML content, compression corruption and decoded byte limits, and all auth/status stops.
The actual AutomaticGate + ProxyPool integration is exercised: first node returns 312/no-type, second node returns completed SSE/292/no-type, one pin is captured, and the cursor points at the third node. Another test traverses four malformed responses and falls back exactly once. 403 does not rotate or fall back.

All regression tests use local mock responses and synthetic credentials. One separate live diagnostic reproduced the header omission and 312 on the first node; it did not obtain a new pin or change configuration. Live success on other nodes remains a separate observation, not established by these tests.
