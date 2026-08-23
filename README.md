# OpenTableBot

Local-first engineering foundation for a pre-authorized restaurant reservation
assistant. Phase 0 contains only provider-neutral domain models, matching and
policy logic, state transitions, and interfaces for future infrastructure.

No OpenTable network requests, browser automation, or real booking behavior are
implemented.

## Requirements

- Node.js 22 (see `.nvmrc`)
- npm

## Development

```sh
npm install
npm run check
npm run build
```

The `check` script runs linting, TypeScript typechecking, and all Vitest tests.

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
