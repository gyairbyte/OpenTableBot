# Reference Notes

## `chrischall/fetchproxy`

- Repository: <https://github.com/chrischall/fetchproxy>
- License: MIT when reviewed
- Phase 1B use: the MAIN-world Apollo-link wrapping and operation-document
  capture pattern was adapted and narrowed to one fixed read-only operation.
  OpenTableBot's same-origin fetch-template fallback was independently added
  when current live pages did not expose the Apollo client globally.
- Differences: OpenTableBot has no arbitrary operation/query API, validates all
  bridge messages, sanitizes output inside Chrome, and uses explicit pairing.

The required attribution and MIT license text are reproduced in
`THIRD_PARTY_NOTICES.md`.

## `chrischall/opentable-mcp`

- Repository: <https://github.com/chrischall/opentable-mcp>
- License: MIT when reviewed
- Phase 1B use: high-level availability variable names informed the fixed
  request shape. No booking, lock, submission, stealth, or proxy code was used.

## `nancyychen-bot/mise-en-place`

- License: no license was confirmed when reviewed
- Treatment: architectural ideas only; no source was copied.

This repository has no owner-selected project license. Reference licenses and
attribution do not license original OpenTableBot code.
