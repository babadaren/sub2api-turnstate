# v0.6.1 — Record pagination validation

## Scope

The recent request/state table displays 20 entries per page, newest first. Previous/next, page-number jump, range/total labels and return-to-latest are provided. Latest-page polling remains active; historical pages retain their anchor and stop polling the table while the rest of the dashboard continues updating. Existing authentication and model automation are unchanged.

The server paginates the existing bounded `Journal.recent` collection. It does not change retention or ingest older rotated files. Default retention is 1000 entries. An explicitly supplied legacy `limit` is still supported (at most 200); the browser always asks for 20. Kind/status filters continue to work.

## Executed tests — 2026-09-19

- Windows development environment: syntax check passed; 81 tests passed, 0 failed, 1 skipped (real Linux Nginx unavailable locally).
- ipxair isolated test directory: syntax check passed; 82 tests passed, 0 failed, 0 skipped, including real Nginx regression tests.
- Server test directory: `/tmp/turnstate-pages061.Ql47UV`. Test upstreams are local mocks. No billable generation was triggered by tests.

Pagination coverage includes complete navigation across 105 retained entries (beyond the former 100-entry UI limit), 20-entry default, final partial page, empty collection, exact page boundary, out-of-range page clamping, malformed input rejection, query filters and legacy limits.

UI-controller tests exercise latest-page polling, stable anchored historical pages despite new arrivals, previous/next/page jump, recovery after an anchor leaves retention, logout invalidation of in-flight responses, duplicate-click suppression, and recovery from a failed fetch. HTTP tests verify unauthenticated rejection, authenticated page separation and static pagination assets.

These are automated controller/API tests, not a claim of manual browser acceptance. Deployment acceptance separately checks live authenticated page counts and disjoint IDs without printing request bodies, credentials or state values.

## Unchanged areas

No changes to `automatic.mjs`, `states.mjs`, `probe-transport.mjs`, model rules, expiry semantics, renewal intervals, egress proxy or log retention. Existing automation/state/transport/security tests are still part of the full suite. Source and package version are 0.6.1.
