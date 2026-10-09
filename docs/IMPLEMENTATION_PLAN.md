# Implementation Plan

## Phase 0: domain foundation (complete)

- Validated targets, slots, previews, confirmations, and policy types
- Deterministic matching/ranking and fail-closed preview evaluation
- Explicit states, adapter failure categories, and provider-neutral ports

## Phase 1A: Playwright read transport (superseded)

The initial dedicated-profile Playwright transport was removed. Live testing
showed ordinary user-controlled Chrome loaded OpenTable while Playwright-
launched Chrome received Access Denied before authentication. The Playwright
implementation correctly failed closed, but it is not retained as a production
or dependency fallback.

## Phase 1B: paired normal-Chrome read adapter (complete)

- User-controlled Chrome and normal OpenTable sign-in
- Thin MV3 extension with least privilege and deterministic unpacked build
- Explicit one-use pairing and authenticated loopback WebSocket protocol
- Fixed page-context `RestaurantsAvailability` operation only
- In-Chrome allowlist sanitization; no browser secrets cross the boundary
- Conservative page classification and invariant-checking slot normalization
- Read/write adapter contracts remain compile-time separated
- CI remains deterministic and has no live OpenTable dependency

The manual authenticated Phase 1 read-only smoke test is complete. Project
licensing and the long-term local storage/encryption model remain owner
decisions.

## Phase 2: booking preview and dry-run validation (complete)

- Fetch `/booking/details` as read-only SSR data for an exact observed slot
- Keep slot hashes and availability tokens in Chrome behind an ephemeral handle
- Normalize exact seating, Experience type, financial terms, currency, payment
  requirement, and observable/unknown SCA state
- Evaluate the existing provider-neutral policy with deterministic reasons
- Print an explicit dry-run result

Phase 2 does not create a prepared context: OpenTable's actual preparation step
is a separate slot-lock mutation. That mutation is deliberately deferred.

The authenticated live smoke test completed against one real Standard slot. It
returned a sanitized booking preview and a deterministic fail-closed policy
result without navigating to checkout, locking inventory, or creating a
reservation.

## Phase 3: controlled slot lock and booking (implemented)

- Unknown currency is accepted only for confirmed zero monetary/payment exposure
- One-time, short-lived authorization is distinct from the preview reference
- Current Standard persisted-query lock is executed in normal Chrome
- Raw provider handles and signed-in profile data remain browser-local
- Critical terms are fetched, sanitized, normalized, and revalidated after lock
- The make-reservation request is built only inside Chrome and dispatched once
- Ambiguous post-dispatch outcomes become terminal `OUTCOME_UNKNOWN`
- The CLI is dry-run by default and needs standalone `--execute` for writes
- Lock uses one propagated 25-second deadline and an explicit provider dispatch boundary
- Lock outcomes are typed as not-dispatched, rejected, confirmed, or unknown
- Lock acknowledgement and post-lock revalidation are separate fail-closed steps
- Late lock success after caller abandonment is browser-local `ORPHANED` state
- Correlated, sanitized stage telemetry identifies the last completed lock boundary
- Reservation kind and dining area are modeled independently
- Provider-ordered dining areas become distinct opaque-reference candidates
- `ANY`, `ALLOW`, and `PREFER` policies support arbitrary sanitized labels
- Read-only first-valid preview selection advances past rejected candidates

Live Stage A read-only evidence succeeded. The first explicitly confirmed Stage
B lock attempt timed out with the old combined lock/revalidation path; available
logs could not prove whether its provider request was dispatched. It was not
retried, no submission occurred, and Stage C was not started. The deterministic
hardening above was completed without another live write.

## Phase 4: bounded known-drop scheduling (foundation implemented)

- Durable, version-checked target store and a local console/file notifier
- Single-shot engine that books only the exact preferred time and pauses otherwise
- Warm-up readiness polling before the release time, then exactly one attempt
- Windows Task Scheduler launch and registration scripts
- Ambiguous submissions remain terminal `OUTCOME_UNKNOWN` and are never retried

Not yet validated: no scheduled live write has completed. See
[Scheduling](SCHEDULING.md).

## Later phases (not started)

- Phase 5: durable cancellation watching
- Phase 6: notifications and operational hardening

Every later phase retains the prohibition on CAPTCHA solving, access-control
evasion, stealth techniques, proxy rotation, fingerprint impersonation, and
rate-limit bypass.
