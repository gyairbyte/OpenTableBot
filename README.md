# OpenTableBot

Local-first engineering foundation for a pre-authorized restaurant reservation
assistant. Phase 3 adds a controlled, single-shot Standard reservation path to
the paired normal-Chrome architecture. It is dry-run by default and implements
an explicit capability, real slot lock, post-lock terms revalidation, and one
reservation-submission attempt. It is not a scheduler, watcher, or sniper.

## Requirements

- Node.js 22 (see `.nvmrc`)
- npm
- Google Chrome with developer mode available for the unpacked extension

## Development

```sh
npm ci
npm run check
npm run build
npm run extension:build
```

The deterministic extension output is `dist/extension`. CI runs the same
lint, typecheck, test, Node build, extension build, and audit checks.

## Phase 1B local setup

1. Build the extension with `npm run extension:build`.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
   and select this repository's `dist/extension` directory.
3. Start the local bridge and create a five-minute, one-use pairing code:

   ```sh
   npm run opentable:bridge -- pair
   ```

4. Open the extension popup, enter the code, and keep the bridge process
   running. The extension stores only the random local bridge credential in
   `chrome.storage.local`; Node stores its copy under ignored
   `.local/bridge/credential.json`. The credential is never printed.
5. Use normal Chrome to open `https://www.opentable.com/` and sign in through
   the site's normal UI. The project never asks for a username or password.

Check bridge/page state with `npm run opentable:status`, then check the visible
page's authentication evidence with:

```sh
npm run opentable:check-auth
```

After visiting an OpenTable restaurant/search page so Chrome has observed the
page's availability operation, perform one read-only query:

```sh
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

The command never clicks a time or enters checkout. If restaurant metadata is
needed for a smoke test, provide the normal OpenTable restaurant URL rather
than searching provider internals manually.

Preview one selected result and evaluate the target policy with:

```sh
npm run opentable:preview -- \
  --restaurant-id 12345 \
  --restaurant-name "Example Restaurant" \
  --date 2026-09-01 \
  --party 2 \
  --earliest 18:00 \
  --latest 20:00 \
  --preferred 19:00 \
  --timezone America/New_York \
  --currency USD \
  --auto-book-authorized false
```

Optional policy flags include `--allow-prepaid`, `--max-prepaid-cents`,
`--max-cancellation-no-show-cents`, `--allow-experiences`, and
`--allow-payment-method-required`. A specific normalized result can be chosen
with `--slot-id`, `--seating`, or `--experience-id`. The command always prints
`DRY RUN ONLY` and never locks inventory or creates a reservation.

The controlled command has the same target/selection flags:

```sh
npm run opentable:book -- --restaurant-id 12345 --restaurant-name "Example Restaurant" \
  --date 2026-09-01 --party 2 --earliest 18:00 --latest 20:00 \
  --preferred 19:00 --timezone America/New_York --auto-book-authorized true
```

Without the standalone `--execute` flag it cannot create a booking capability
or lock inventory. `--execute` enables one controlled Standard lock and at most
one submission. Payment-backed, prepaid, Experience, and interactive SCA/3DS
bookings fail closed.

A lock has four explicit outcomes: `LOCK_NOT_DISPATCHED`, `LOCK_REJECTED`,
`LOCK_CONFIRMED`, and `LOCK_OUTCOME_UNKNOWN`. The last state is terminal for
that authorization: the lock is never retried automatically and no reservation
may be submitted from an abandoned or unacknowledged browser-local result.

Stop the bridge with Ctrl+C. Revoke an existing pairing with:

```sh
npm run opentable:bridge -- revoke
```

See [Chrome bridge operations](docs/OPENTABLE_BROWSER_SESSION.md) for setup,
recovery, threat boundaries, and permission rationale.

## Safety model

The WebSocket server binds only to `127.0.0.1`. Both the extension and local
controller authenticate with a random paired credential. Messages are
versioned, strictly validated, deadline-bound, and limited to narrow status,
read, authorization, lock, acknowledgement, revalidation, and submission
messages. The extension exposes no arbitrary URL, method, request body, fetch,
or script execution interface.

OpenTable cookies, storage, headers, and account tokens never leave Chrome.
Before an availability result crosses the extension boundary it is reduced to
restaurant/day identifiers, a short-lived browser-local preview reference, and
non-sensitive slot time/seating/Experience fields. Booking hashes and
availability tokens remain in page memory. A preview reference can invoke only
one fixed same-origin `GET /booking/details`; it cannot invoke either
`BookDetailsStandardSlotLock` or `BookDetailsExperienceSlotLock`. Node
revalidates restaurant, date, time, party, seating, reservation kind, time
zone, and payload shape.

Preview output is an explicit allowlist: restaurant and slot invariants,
Experience metadata, structured prepaid/cancellation/no-show terms, currency,
whether a payment method is required, and observable strong-authentication
state. Saved-card identifiers and details, payment tokens, profile data,
cookies, headers, page query secrets, and raw provider payloads never cross
into Node. Unknown monetary, payment, or SCA facts remain unknown and fail
closed. Unknown currency alone is accepted only when prepaid, cancellation,
no-show, and payment exposure are all confirmed absent.

Challenge, access-denied, rate-limited, unauthenticated, malformed, and
unclassifiable states fail closed. This project will not implement CAPTCHA
solving, anti-bot or access-control evasion, stealth techniques, proxy rotation,
fingerprint impersonation, or rate-limit bypass.

## Structure

- `extension`: MV3 manifest, popup, page/content bridge, and deterministic build
- `src/domain`: targets, normalized reservation data, matching, policy, state
- `src/opentable/browser`: conservative page classification and slot normalization
- `src/opentable/bridge`: loopback protocol, pairing, broker, client, and read adapter
- `src/runner`: provider-neutral booking planning boundary (future phases)
- `tests`: domain, classifier, normalizer, bridge, and protocol tests
- `docs`: architecture, operations, plan, and reference notices

## License

No project license has been selected by the repository owner, so no license is
granted by this repository at this time. See `THIRD_PARTY_NOTICES.md` for the
MIT-licensed reference code adapted in Phase 1B.
