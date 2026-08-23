# OpenTableBot

Local-first engineering foundation for a pre-authorized restaurant reservation
assistant. Phase 1B connects a normal, user-controlled Chrome session to a
local Node.js process for authenticated, read-only OpenTable availability.

No booking preparation, slot locking, checkout interaction, account mutation,
or reservation submission is implemented.

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

Stop the bridge with Ctrl+C. Revoke an existing pairing with:

```sh
npm run opentable:bridge -- revoke
```

See [Chrome bridge operations](docs/OPENTABLE_BROWSER_SESSION.md) for setup,
recovery, threat boundaries, and permission rationale.

## Safety model

The WebSocket server binds only to `127.0.0.1`. Both the extension and local
controller authenticate with a random paired credential. Messages are
versioned, strictly validated, deadline-bound, and limited to status,
authentication evidence, and availability. The extension exposes no arbitrary
page query or script execution interface.

OpenTable cookies, storage, headers, and account tokens never leave Chrome.
Before an availability result crosses the extension boundary it is reduced to
restaurant/day identifiers and non-sensitive slot time/seating fields. Booking
hashes and availability tokens are discarded. Node revalidates restaurant,
date, time, party, time zone, and payload shape before returning normalized
slots.

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
