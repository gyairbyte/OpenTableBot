# Architecture

## Core flow

```text
Booking Target
    -> Scheduler / Runner
    -> Slot Matcher and Ranker
    -> OpenTableAdapter.prepareBooking
    -> Policy Validator (PreparedBooking.preview only)
    -> OpenTableAdapter.book(PreparedBooking)
    -> Booking Confirmation
```

The `BookingTarget` is the user's complete pre-authorization envelope. It
contains the restaurant, date range, party size, acceptable and preferred time,
ordered allowed seating types, mode, optional known release timestamp, and the
maximum financial/interaction authority granted to the application.

The scheduler decides *when* a target should run. The runner owns the generic
workflow and target state. Neither understands OpenTable URLs, payloads,
authentication cookies, browser state, or response formats.

The slot matcher filters normalized `ReservationSlot` values and ranks them by
distance from preferred time. Its deterministic tie-break order is earliest
date, earliest time, target seating preference, then stable slot ID. The runner
can therefore try a selected slot followed by deterministic fallbacks if the
first disappears.

The policy validator compares the normalized `BookingPreview` inside a
`PreparedBooking` with both the selected slot and the target. Cancellation and
no-show terms explicitly distinguish confirmed no fee, a known amount, and an
unknown amount. Prepaid terms distinguish no requirement, a required known
amount, and a required unknown amount. Unknown financial terms always fail
closed; they are never treated as zero.

Only `OpenTableAdapter` may contain OpenTable-specific behavior. It converts
provider responses into domain types and exposes authentication checking, slot
discovery, booking preparation, and booking. Isolating this implementation prevents
provider churn from leaking into scheduling, matching, policy, persistence,
notifications, or state management and lets all core behavior be tested without
network access.

`PreparedBooking.bookingHandle` is an opaque adapter-owned reference to an
ephemeral prepared or held context. It may be sensitive. It exists only in
memory between preparation and submission and must never be interpreted by
domain code, persisted, logged, placed in a notification, or exposed to a user.
The optional `expiresAt` supports provider-supplied hold expiry without exposing
provider-specific token formats or mechanics.

## State model

```text
DRAFT -> ARMED -> WAITING -> MATCH_FOUND -> VALIDATING -> BOOKING -> BOOKED
                    ^            |             |            |
                    +------------+-------------+------------+
                                 retryable failure

ARMED / WAITING / MATCH_FOUND / VALIDATING / BOOKING -> PAUSED
PAUSED -> ARMED (explicit remediation and re-arming)
```

`BOOKED` is terminal for the current target. A new desired reservation requires
a new target. This prevents a successful target from producing duplicate
bookings. Retryable slot disappearance or transient failures return to
`WAITING`; safety-sensitive failures transition to `PAUSED`.

## Fail-closed boundary

Authentication required/expired, CAPTCHA or challenge pages, access-control
responses, unexpected booking terms, a charge above authorization, 3DS/SCA,
unexpected seating/date, and ambiguous responses must pause. Human remediation
and explicit re-arming are required. Rate limiting may use a bounded scheduled
retry, but never a bypass.

The design explicitly excludes CAPTCHA solving, anti-bot evasion, stealth
browser techniques, proxy rotation, TLS/browser fingerprint impersonation,
rate-limit bypass, and access-control bypass.

## Local-first persistence

`TargetStore` and `Notifier` are ports. A later local implementation can persist
targets and run history without changing domain code. Sensitive authentication
material, browser profiles, and prepared booking handles must remain outside
domain records, logs, source control, and notification payloads.
