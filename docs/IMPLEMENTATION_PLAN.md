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

## Later phases (not started)

- Phase 3: explicit slot preparation/locking and controlled booking design
- Phase 4: bounded known-drop scheduling
- Phase 5: durable cancellation watching
- Phase 6: notifications and operational hardening

Every later phase retains the prohibition on CAPTCHA solving, access-control
evasion, stealth techniques, proxy rotation, fingerprint impersonation, and
rate-limit bypass.
