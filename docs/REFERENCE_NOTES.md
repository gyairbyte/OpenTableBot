# Reference Notes

No implementation source was copied into Phase 0. The references informed only
the architectural concepts described below.

## `chrischall/opentable-mcp`

- Repository: <https://github.com/chrischall/opentable-mcp>
- License: MIT at the time reviewed
- Useful concepts: a clean provider client boundary, normalized slot and booking
  details, separate slot-lock/submission concerns, saved-card-aware booking
  terms, and structured errors
- Phase 0 treatment: concepts were re-expressed as independent provider-neutral
  types and the `OpenTableAdapter` interface; no request or booking code was used

## `nancyychen-bot/mise-en-place`

- Repository: <https://github.com/nancyychen-bot/mise-en-place>
- License: no license was confirmed at the time reviewed
- Useful concepts: target monitoring, known-time scheduled attempts,
  preferred-time choice, fallback/retry behavior, notifications, and disabling
  auto-book after success
- Phase 0 treatment: concepts were independently modeled in the target, ranking,
  state machine, and future plan; source was not copied

The licensing distinction matters: an MIT-licensed reference can be reused only
under its license and attribution terms, while an unlicensed repository must be
treated as all-rights-reserved. This project currently has no owner-selected
license of its own, so no `LICENSE` file was added.
