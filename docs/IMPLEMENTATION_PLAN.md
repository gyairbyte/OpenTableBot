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

## Phase 1B: paired normal-Chrome read adapter (current)

- User-controlled Chrome and normal OpenTable sign-in
- Thin MV3 extension with least privilege and deterministic unpacked build
- Explicit one-use pairing and authenticated loopback WebSocket protocol
- Fixed page-context `RestaurantsAvailability` operation only
- In-Chrome allowlist sanitization; no browser secrets cross the boundary
- Conservative page classification and invariant-checking slot normalization
- Read/write adapter contracts remain compile-time separated
- CI remains deterministic and has no live OpenTable dependency

Before Phase 2, complete the manual authenticated read-only smoke test, resolve
the project license, and choose the long-term local storage/encryption model.

## Phase 2: booking preview and dry-run validation (not started)

- Normalize exact seating, financial terms, currency, and interaction needs
- Add an ephemeral prepared context without submitting a reservation
- Exercise policy validation and audit redaction only

## Later phases (not started)

- Phase 3: controlled booking behind explicit authorization
- Phase 4: bounded known-drop scheduling
- Phase 5: durable cancellation watching
- Phase 6: notifications and operational hardening

Every later phase retains the prohibition on CAPTCHA solving, access-control
evasion, stealth techniques, proxy rotation, fingerprint impersonation, and
rate-limit bypass.
