# v0.7.0 — Model controls and length-based acceptance

## Requested behavior

The operator requested that configured state length, rather than exact response-model equality, decide acceptance. A successful `gpt-5.6-sol` request reporting `gpt-6-sol` with a 292-byte state now qualifies. This policy applies to all configured request models: a different model (including luna) or missing response model does not independently reject a successful target-length state. Model identity is not guaranteed by length; actual declarations remain visible, and neither request nor response model strings are rewritten.

Acceptance still requires a single safe header, target length, successful HTTP status, and successful completion or the already-supported output-limit terminal event. Failed/incomplete nonterminal responses, malformed/duplicate headers, authentication errors and transport failures do not become successes. Request-model/credential/session isolation, TTL, early renewal, stale-response protection, and non-replay of original requests remain.

## Model management

The console includes per-model Edit, Disable/Enable and Delete buttons. Edit respects the Enabled checkbox rather than unconditionally enabling on save. `POST /api/rules/model` performs a single-model mutation after the existing authentication/Origin/CSRF checks. Disable preserves the rule but clears that model's pins and memory credentials; delete removes the extension rule. Both cancel only that model's work and release still-connected queued originals unchanged, not as a 503. Other model jobs/renewal plans survive. Records are not erased; deleting an extension rule does not delete any Sub2API model/account.

## Verified tests

Windows full suite: 123 total, 122 passed, 1 skipped (real Nginx unavailable), 0 failed.

ipxair isolated full suite, final run: **123 passed, 0 failed, 0 skipped**, about 6.7 seconds. Node runtime `/opt/node-v22.23.2-linux-x64/bin`, actual server Nginx, temporary test directory `/tmp/turnstate-model070-final.aVwNNW`. Tests use separate loopback mock servers and synthetic credentials/states, never production keys or paid model calls.

New regressions cover:

- sol -> 6-sol 292 capture, injection, reuse, restart persistence and truthful response metadata.
- different/missing response model accepted by length; failed/no-terminal 292 remains rejected.
- 312 then 292 acceptance without name-mismatch loops; proactive renewal remains armed for grey-name pins.
- request-model and credential isolation even when two models return the same length.
- per-model disable, enable, delete, idempotent deletion, save-disabled and reload behavior.
- disable/delete during active discovery releases an original once; unrelated model renewal credentials remain.
- rapid disable/re-enable and already-forwarded response cannot resurrect stale work or rewrite a released original.
- authenticated management, CSRF, prototype-name rejection and explicit enable/save acknowledgement.

Old equality-specific tests were updated to the new contract; ordinary errors, explicit state rejection, authentication isolation, stream transport, pagination and renewal tests remain. The first Linux run exposed an old Nginx test fixture that assumed an unknown-model 312 stopped discovery. Under the new policy it correctly retries. The test now supplies an actual HTTP 502 probe failure to verify that the generated 503 does not replay the original through Nginx's backup. The final full run passed; production Nginx settings were not changed to hide a timeout.

## Deployment boundary

The release contains only the independent extension, not a Sub2API source/image modification. It adds no proxy-node pool and preserves configured egress. The controlled updater backs up owned service files, checks package SHA-256, pauses ongoing discovery through the existing transparent-stop control, drains originals, installs the separate version directory, restores the prior global switch, and checks saved pin fingerprints/expiries and unchanged model rules before reconnecting Nginx. A running stream that cannot drain causes rollback instead of forced termination.

This report verifies code and isolated behavior, not a claim that a current production upstream necessarily returns 292. Repeated 312 still fails a configured 292 criterion.
