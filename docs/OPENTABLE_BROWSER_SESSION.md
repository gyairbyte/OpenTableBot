# Chrome Bridge Operations

Phase 1B uses the user's normal Chrome session plus an unpacked read-only MV3
extension. Node does not launch or control Chrome and does not read a Chrome
profile.

Phase 3 adds only five explicit controlled-booking operations:
`AUTHORIZE_BOOKING`, `LOCK_SLOT`, `ACKNOWLEDGE_LOCK`,
`REVALIDATE_PREPARED_BOOKING`, and `SUBMIT_RESERVATION`. None accepts a URL,
method, headers, provider request body, JavaScript, provider token, or payment
data. MAIN-world code owns the fixed Standard provider operations.

`opentable:book` is dry-run by default. The standalone `--execute` flag is the
developer safety interlock and must be used only after checking the exact
displayed selection. If a dispatched submission cannot be confirmed, it
returns terminal `OUTCOME_UNKNOWN`; do not retry before checking the user's
OpenTable reservations manually.

`LOCK_SLOT` uses one absolute deadline across Node and Chrome. Its sanitized
stage log distinguishes a timeout before provider dispatch
(`LOCK_NOT_DISPATCHED`) from any interruption after dispatch
(`LOCK_OUTCOME_UNKNOWN`). A confirmed response is not submit-capable until Node
acknowledges it and a separate post-lock revalidation succeeds. If the bridge
disconnects, the content request expires, or a result arrives after abandonment,
the browser-local handle is orphaned and can only expire; it is never submitted.

## Build, load, and pair

```sh
npm ci
npm run extension:build
npm run opentable:bridge -- pair
```

Load `dist/extension` from `chrome://extensions` using Developer mode and
**Load unpacked**. Enter the printed one-time code in the extension popup. The
code expires after five minutes and is consumed once. Keep the bridge command
running during reads.

Pairing creates `.local/bridge/credential.json` and stores the same random
credential in `chrome.storage.local`. The file is ignored by Git. Never copy
it into logs, fixtures, support messages, or source control. The bridge prints
only the short-lived pairing code, never the credential.

Use OpenTable normally in Chrome, including normal interactive sign-in. The
extension and Node process do not request or export usernames, passwords,
cookies, local storage, session headers, or account tokens.

## Status and read-only checks

```sh
npm run opentable:status
npm run opentable:check-auth
```

Status reports whether the extension is connected and an eligible OpenTable
page is ready. Authentication is based on conservative visible page evidence;
inconclusive, challenge, blocked, or rate-limited pages fail closed.

For availability, first visit the intended restaurant/search page and perform
a normal read-only availability search so the page has loaded its operation.
The bridge reuses a live Apollo document when available; otherwise it retains
the normal page's exact same-origin availability request template in page
memory. Neither template nor browser headers are sent to Node. Then run the
`opentable:slots` command documented in the README. The page bridge's only
GraphQL operation is `RestaurantsAvailability`; Phase 2 additionally permits
the fixed details GET described below. It does not click slots, lock or
prepare reservations, enter checkout, book, cancel, or mutate the account.

## Phase 2 preview

After `opentable:slots` has produced a current slot, run the
`opentable:preview` command documented in the README. The availability result
contains a random ten-minute browser-local reference; provider slot hashes and
availability tokens remain in MAIN-world memory.

The preview reference can perform only a credentialed same-origin
`GET /booking/details` for the exact observed restaurant, date, time, party,
seating, and Experience. The response is read as text and its JSON state is
allowlisted before Node receives it. The extension never navigates to or
executes the checkout page, and it contains no
`BookDetailsStandardSlotLock`, `BookDetailsExperienceSlotLock`, or
`make-reservation` request.

The dry-run output may reject because currency, payment requirements, or SCA
are unknown. That is intentional fail-closed behavior. Saved cards, account
profile fields, card identifiers, payment tokens, cookies, authorization
headers, and the query-bearing booking-details URL are never returned to Node.

## Recovery and revocation

- Bridge offline: restart `npm run opentable:bridge`; the stored credential is
  reused and the extension reconnects.
- Extension not connected: confirm the bridge is running on port 38471, reload
  the unpacked extension, and inspect its popup status.
- Page operation unavailable: reload/visit a normal restaurant availability
  page and perform an ordinary search so `RestaurantsAvailability` is observed.
- Pairing lost or suspected credential exposure: stop the bridge and run
  `npm run opentable:bridge -- revoke`, then start `pair` and pair again.
- Alternate port: set `OPENTABLE_BRIDGE_PORT` for Node and enter the same port
  in the popup during pairing.

No recovery step should disable site security, solve/bypass a challenge,
change fingerprints, route through a proxy, or repeatedly retry a block.

## Threat boundary

The broker listens only on IPv4 loopback and authenticates every operational
connection. Strict message schemas reject extra fields, arbitrary operations,
and expired requests. The content script sends only allowlisted availability
fields. The local credential proves pairing, not user identity, and does not
grant OpenTable access outside the already signed-in Chrome page.

The design protects against unrelated local web pages and accidental network
exposure. It does not claim to protect against malware already running with the
same OS user privileges or a malicious unpacked extension with equivalent
Chrome access.
