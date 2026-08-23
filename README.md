# OpenTableBot

Local-first engineering foundation for a pre-authorized restaurant reservation
assistant. Phase 1 adds an authenticated, read-only OpenTable browser adapter
while keeping all booking operations outside the implementation.

No booking preparation, slot locking, checkout interaction, account mutation,
or reservation submission is implemented.

## Requirements

- Node.js 22 (see `.nvmrc`)
- npm
- Google Chrome installed locally for the Phase 1 browser commands

## Development

```sh
npm install
npm run check
npm run build
```

The `check` script runs linting, TypeScript typechecking, and all Vitest tests.

## Phase 1 read-only browser commands

The browser adapter launches normal installed Chrome in a headed persistent
context. Its dedicated profile defaults to
`.local/opentable-browser-profile/` and never attaches to an everyday Chrome
profile. Override it with `OPENTABLE_BROWSER_PROFILE_DIR` when needed.

```sh
npm run opentable:login
npm run opentable:check-auth
npm run opentable:slots -- \
  --restaurant-id 12345 \
  --restaurant-name "Example Restaurant" \
  --date 2026-09-01 \
  --party 2 \
  --earliest 18:00 \
  --latest 20:00 \
  --preferred 19:00 \
  --timezone America/New_York
```

The login command opens the dedicated profile and lets the user authenticate
only through OpenTable's normal browser experience. The application never asks
for or stores a password. Cookies and session state remain browser-managed in
the ignored local profile and are never exported or logged.

Availability is acquired by navigating the normal search page and observing
the structured availability response that the page naturally generates. The
adapter does not synthesize private requests, click reservation slots, or rank
results. See [OpenTable browser session](docs/OPENTABLE_BROWSER_SESSION.md).

## Safety model

A booking can proceed only when the exact slot and preview remain inside the
target's pre-authorized date, time, seating, prepaid, fee, currency, and
auto-book policy. Unknown prepaid, cancellation, or no-show amounts fail closed
instead of being interpreted as zero. Authentication failures, challenge pages,
access-control responses, unexpected terms, strong-customer-authentication
prompts, and ambiguous responses are designed to pause processing.

Future booking preparation returns an opaque, potentially sensitive in-memory
handle. It must never be persisted, logged, included in notifications, or
exposed to users.

This project will not implement CAPTCHA solving, anti-bot or access-control
evasion, stealth browser techniques, proxy rotation, fingerprint impersonation,
or rate-limit bypass.

## Structure

- `src/domain`: validated targets, normalized reservation data, matching,
  ranking, policy evaluation, and state transitions
- `src/opentable`: the isolated adapter contract and structured failure taxonomy
- `src/opentable/playwright`: persistent browser session, page classification,
  natural-response observation, normalization, and read-only CLI
- `src/runner`: provider-neutral booking planning/orchestration boundary
- `src/storage`: persistence port
- `src/notifications`: notification port
- `tests`: pure domain and failure-classification tests
- `docs`: architecture, phased implementation plan, and reference notes

See [Architecture](docs/ARCHITECTURE.md) and the
[Implementation plan](docs/IMPLEMENTATION_PLAN.md) for the intended evolution.

## License

No project license has been selected by the repository owner, so no license is
granted by this repository at this time.
