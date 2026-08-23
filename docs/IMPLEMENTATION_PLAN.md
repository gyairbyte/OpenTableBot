# Implementation Plan

## Phase 0: domain foundation (this phase)

- Validated booking target, slot, preview, confirmation, and policy types
- Deterministic slot matching/ranking and fail-closed preview evaluation
- Explicit state transitions and adapter failure categories
- Provider-neutral adapter, storage, notification, and runner boundaries
- Unit tests and architecture documentation
- No OpenTable calls, browser automation, UI, or hosted infrastructure

## Phase 1: normal authenticated-browser OpenTable read-only adapter

- Implement the adapter with a normal user-controlled authenticated browser
- Check authentication and normalize read-only slot results
- Detect challenges/access-control responses and pause; do not evade them
- Add fixtures and contract tests with sanitized, non-personal data

## Phase 2: booking preview and dry-run validation

- Normalize exact seating, explicit prepaid/cancellation/no-show financial
  terms, currency, and interaction requirements
- Return an in-memory `PreparedBooking` whose opaque handle is passed unchanged
  to booking and is never persisted or logged
- Exercise the full state flow through `VALIDATING` without submitting a booking
- Record auditable policy decisions with sensitive-data redaction

## Phase 3: controlled real booking

- Add an explicit, tightly scoped booking implementation behind the adapter
- Require target auto-book authorization and a passing fresh preview
- Support deterministic fallback when a selected slot disappears
- Make `BOOKED` terminal and disable further attempts for that target

## Phase 4: known-drop sniper

- Add local scheduling around an optional known release timestamp
- Use bounded attempts, jitter appropriate to normal load, and conservative
  retry/backoff behavior
- Never bypass rate limits or access controls

## Phase 5: cancellation watcher

- Add durable, bounded polling for cancellation-watch targets
- Persist checkpoints and avoid duplicate work across process restarts
- Keep the same matcher, policy, and terminal-success semantics

## Phase 6: notifications and operational hardening

- Implement local notification channels for booking, pause, and failure events
- Add structured redacted logs, metrics, recovery testing, and runbooks
- Add retention controls, health checks, concurrency guards, and safe shutdown

Before Phase 1, resolve the project license, confirm OpenTable terms and account
expectations for the intended use, and choose the local storage/encryption model.
