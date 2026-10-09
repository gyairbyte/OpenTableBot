# OpenTableBot

Local-first engineering foundation for a pre-authorized restaurant reservation
assistant. Phase 3 adds a controlled, single-shot Standard reservation path to
the paired normal-Chrome architecture. It is dry-run by default and implements
an explicit capability, real slot lock, post-lock terms revalidation, and one
reservation-submission attempt. Phase 4 adds a bounded known-drop scheduler that
warms up before a release time and performs exactly one attempt; see
[docs/SCHEDULING.md](docs/SCHEDULING.md).

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
`--allow-payment-method-required`. Dining areas default to
`--dining-area-mode any`, with provider order as the deterministic selection
rule. `allow` accepts comma-separated `--dining-area-categories` and/or exact
`--dining-area-labels`; `prefer` accepts ordered entries such as
`--dining-area-preferences category:rooftop,label:Sky Terrace` and
`--dining-area-fallback any|none`. A specific normalized result can be chosen
with `--slot-id`, `--dining-area-category`, `--dining-area-label`, the legacy
`--seating`, or `--experience-id`. The command evaluates candidates with
read-only previews until the first policy-authorized option. It always prints
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

## Operator console

To search restaurants and manage scheduled tasks in a browser instead of flags,
start the loopback console (it embeds the known-drop scheduler):

```sh
npm run opentable:ui
```

It serves `http://127.0.0.1:8790` and, like the CLI, needs the bridge running
and a signed-in OpenTable tab open. Without `--execute` every scheduled run is
a dry run. The console searches restaurants with typeahead, checks live
availability so you can pick real times and real dining areas, previews the
booking terms and the fail-closed policy decision before a drop, and lets you
edit, arm, pause, and delete tasks. See
[Scheduling a known drop](docs/SCHEDULING.md#operator-console).

### Starting the console

`npm run opentable:ui` is the console itself, and it needs the bridge running
too. The usual way to start both by hand is:

```sh
npm run opentable:bridge   # one terminal, keep it running
npm run opentable:ui       # another terminal, then open http://127.0.0.1:8790
```

Two launchers wrap that, and both are what the desktop icons run:

```powershell
.\scripts\start-opentable.ps1    # bridge + console, hidden, logs to .local\logs
.\scripts\stop-opentable.ps1     # stops both, process trees included
```

`start-opentable.ps1` skips whatever is already listening, waits for both ports,
opens a normal signed-in OpenTable tab for the extension, reports bridge and
session state, and opens the console page. It defaults to DRY_RUN; pass
`-Execute` to let armed tasks submit real reservations, which is fixed when the
process starts. Use `-NoOpenTable` only if you already have an eligible
OpenTable tab open. It also starts the bridge that the scheduled drop needs, so
a drop triggered while it is running finds a live bridge.

`stop-opentable.ps1` refuses to stop the bridge while an unattended scheduled
run holds the scheduler lock, because that could abandon a reservation
mid-booking; pass `-Force` to override. Add `-KeepBridge` to stop only the
console. Chrome is left open in both cases.

### Desktop icons

```powershell
.\scripts\install-desktop-shortcuts.ps1            # dry-run icons
.\scripts\install-desktop-shortcuts.ps1 -WriteMode # Start icon runs -Execute
.\scripts\install-desktop-shortcuts.ps1 -Remove    # delete both icons
```

This writes **Start OpenTable** and **Stop OpenTable** to your Desktop. The
Start icon brings up the bridge and console and opens the page; the Stop icon
shuts both down. Each keeps its window open if something needs attention, so a
failure is readable instead of a window that flashes and closes. Re-run the
installer after moving the repository, since the shortcuts hold absolute paths.

## Unattended drops

You do not have to keep Chrome or the bridge open. `scripts/register-scheduled-task.ps1`
registers a Windows task that wakes the machine before the release time and runs
`scripts/run-scheduled.ps1`, which opens the restaurant page in your signed-in
Chrome profile, starts the bridge if it is not already running, and waits for the
extension and an eligible page to report ready. If the browser never becomes
ready, the target is paused with the readiness reason instead of booking against
a page that is not there.

Only Chrome's OpenTable sign-in still needs a human, once. See
[Unattended startup](docs/SCHEDULING.md#unattended-startup).

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
restaurant/day identifiers, short-lived browser-local preview references, and
non-sensitive slot time/seating/Experience fields. A fixed read-only details
request then expands each time into distinct dining-area candidates containing
only normalized category, sanitized provider label, and provider order. Booking hashes and
availability tokens remain in page memory. A preview reference can invoke only
one fixed same-origin `GET /booking/details`; it cannot invoke either
`BookDetailsStandardSlotLock` or `BookDetailsExperienceSlotLock`. Node
revalidates restaurant, date, time, party, exact dining area, reservation kind, time
zone, and payload shape.

Reservation kind and dining area are independent. Standard remains the default
and Experiences require explicit authorization. `ANY` dining area accepts
unrecognized provider labels; `ALLOW` is an exact category/label allowlist;
`PREFER` ranks configured categories or labels first and follows its explicit
fallback. The legacy target field `allowedSeatingTypes` remains only as a
deterministic compatibility shorthand and cannot coexist with
`diningAreaPolicy`.

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
