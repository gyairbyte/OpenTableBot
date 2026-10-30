# Scheduling a known drop

Phase 4 adds a bounded known-drop scheduler. You describe a target (restaurant,
date, party, exact preferred time, and the release time), and the scheduler warms
up before the release, waits for the drop, and makes exactly one attempt.

The same scheduler also runs cancellation watchers, which poll for an opening
instead of waiting for a release. See
[Watching for cancellations](#watching-for-cancellations).

## What the scheduler does and does not do

These rules describe a `known-drop` target. A `cancellation-watch` target
deliberately relaxes the first two, and only those two; see
[Watching for cancellations](#watching-for-cancellations).

- It selects **only** a slot at the target's exact `timeWindow.preferred` time.
  If that time is absent, it pauses the target and notifies instead of taking a
  nearby time. A target can opt out of this with `acceptAnyTimeInWindow`; see
  [Booking any time in the window](#booking-any-time-in-the-window).
- It runs **once**. There is no post-drop retry loop.
- Ambiguous submissions become terminal `OUTCOME_UNKNOWN` and are never retried.
- Any challenge, sign-out, access denial, or failure pauses the target and logs it.
- Every run records a structured **availability detail** on the target: when
  each availability attempt ran, how long it took, and every open time the page
  returned, including times outside the configured earliest/latest window. A
  no-match pause reason summarizes it, and the console task table expands the
  full per-attempt evidence so "0 slot(s) were returned" can be distinguished
  from "open times existed, but all outside my window". The detail is replaced
  at the start of each new run and never influences slot selection.
- Live booking is the default. Pass `--dry-run` to inspect timing, availability,
  and policy without locking or submitting.

## Prerequisites

- Node.js 22 and dependencies installed (`npm ci`).
- The extension built (`npm run extension:build`) and loaded unpacked in Chrome.
- Chrome paired to the local bridge (`npm run opentable:bridge -- pair`).
- The machine is on and Chrome can be launched with the signed-in profile.
- The target exists in the state file (see below).

The scheduler does **not** launch Chrome. Task Scheduler does, via
`scripts/run-scheduled.ps1`, which also opens the restaurant page so the
extension's content scripts load and capture the page's availability operation.
See [Unattended startup](#unattended-startup) for what that script does and what
still needs a human once.

## Target state file

Targets live in `.local/state/targets.json` (override the directory with
`OPENTABLE_BOT_STATE_DIRECTORY`). The file is versioned and written atomically:

```json
{
  "version": 1,
  "records": [
    {
      "version": 1,
      "createdAt": "2026-10-09T12:00:00.000Z",
      "updatedAt": "2026-10-09T12:00:00.000Z",
      "state": "ARMED",
      "target": {
        "id": "don-angie",
        "restaurant": {
          "id": "12345",
          "name": "Don Angie",
          "timeZone": "America/New_York"
        },
        "dateRange": { "startDate": "2026-11-08", "endDate": "2026-11-08" },
        "partySize": 2,
        "timeWindow": {
          "earliest": "19:00",
          "latest": "21:00",
          "preferred": "19:00"
        },
        "diningAreaPolicy": { "mode": "any", "selection": "provider-order" },
        "bookingPolicy": {
          "allowPrepaid": false,
          "maxAuthorizedPrepaidDollars": 0,
          "maxAuthorizedCancellationNoShowDollarsPerPerson": 0,
          "currency": "USD",
          "allowExperiences": false,
          "allowPaymentMethodRequired": false,
          "autoBookAuthorized": true
        },
        "mode": "known-drop",
        "knownReservationReleaseAt": "2026-11-08T10:00:00-05:00"
      }
    }
  ]
}
```

A target is runnable from state `ARMED` or `WAITING`. The scheduler ignores any
other state, so a completed or paused target is never re-run by accident.

## Running it

```sh
# Live run against every runnable target
npm run opentable:schedule

# One target, real booking
npm run opentable:schedule -- --target-id don-angie

# One target, dry run
npm run opentable:schedule -- --target-id don-angie --dry-run
```

Options:

- `--target-id <id>` restricts the run to one target.
- `--dry-run` disables locking and submission for this run.
- `--tick-seconds <n>` polling interval while waiting for a drop (default 5).
- `--max-runtime-minutes <n>` upper bound before exiting (default 30).
- `--warm-up-seconds <n>` how long before the drop to start readiness checks and
  warm-up (default 180).
- `--readiness-seconds <n>` how long to wait for the extension and an eligible
  page before proceeding (default equals the warm-up).
- `--availability-attempts <n>` availability lookups to make when the exact
  preferred time is absent (default 1).
- `--availability-retry-delay-ms <n>` delay between those lookups in
  milliseconds (default 250).

For `known-drop` targets, the scheduler warms up before
`knownReservationReleaseAt`, polls readiness until the extension and an
eligible page are available, then waits for the release time and runs once. If
the exact preferred time is absent, it can make the configured bounded number
of additional availability lookups. It never substitutes a nearby time unless
the target sets `acceptAnyTimeInWindow`.

### Booking any time in the window

Set `"acceptAnyTimeInWindow": true` on a `known-drop` target (the "Book any open
time in the earliest-latest window" checkbox in the console) to give it a range
instead of a single time. The run still happens once at the release time, but it
now ranks every acceptable slot in `timeWindow.earliest`-`latest` and books the
one closest to `timeWindow.preferred`, so an exact 19:00 table wins when it is
open and a lone 20:30 table is taken when it is not. Ties resolve by earlier
time, then dining-area preference. The same fail-closed booking policy gates the
chosen slot. If nothing in the window is open the target still pauses, and the
pause reason names the window rather than the preferred time.

The flag defaults to off, and it has no effect on a `cancellation-watch` target,
which always works this way. With several availability attempts configured, the
first attempt that finds any acceptable time books it; it does not keep
retrying in the hope the exact preferred time appears.

### Watching for cancellations

A `cancellation-watch` target is the opposite shape: instead of one attempt at a
known moment, it keeps looking for a table that someone else gives up.

The scheduler checks every 10 seconds while the process keeps running. It
accepts any acceptable time inside the target's earliest/latest window and
takes the one closest to `timeWindow.preferred`, so a 19:15 opening wins over an
18:00 one when 19:00 was asked for. It books by itself only in Live mode and
only when the same fail-closed booking policy authorizes the exact terms, which
is the identical gate a known drop passes through.

A watcher keeps watching, staying `ARMED`, when:

- a scan finds nothing acceptable, which is the normal case;
- the browser is momentarily unavailable, since a closed tab or a resuming
  machine must not end an hours-long watch;
- a retryable failure (rate limiting, a dropped transport, a gateway error such
  as HTTP 502, 503, or 504 from the availability request, a lock that was never
  dispatched) interrupts a scan or a lock attempt;
- the browser page is not ready: no eligible OpenTable page is bound, or the
  restaurant page has not yet made the availability request the extension
  replays (a reloaded or wrong tab). A known-drop target still pauses on these.

A watcher stops when:

- a booking is confirmed, which is terminal `BOOKED`;
- its restaurant-local `cancellationWatchStopAt` time arrives, or the
  reservation date passes in the restaurant's timezone;
- anything needing a human appears, such as a challenge, a sign-out, or a
  policy rejection, which pauses it with the reason;
- a submission fails ambiguously. The reservation may exist, so the watcher
  pauses for inspection rather than risk booking the same table twice.

A watcher that stays armed but cannot scan is not silently watching nothing.
When a poll is skipped because the browser is not ready, or the engine resumed
the watch without completing a scan, the scheduler tracks how long it has been
blind. After 10 minutes it emits a `watcher-blind` notification with the reason,
repeated every 10 minutes while it stays blind, and a `watcher-recovered`
notification once a scan completes. The console shows the last reason under the
task as "Could not scan on the last poll". Notifications go to the local log
only (`.local/logs/notifications.log`); nothing is pushed off the machine.

Dry Run watchers keep scanning without locking or submitting, so they can be
left running to confirm what the watcher would have taken. Each poll stores its
availability detail on the target, which means the console always shows what
the most recent scan actually saw.

## Operator console

`npm run opentable:ui` starts a loopback HTTP console on
`http://127.0.0.1:8790` that drives the same store, engine, and scheduler as the
CLI. It accepts the same flags as the scheduler for `--tick-seconds`,
`--warm-up-seconds`, and `--dry-run`, plus `--port <n>`. It starts in Live mode;
the header control switches between Live and Dry Run without restarting.
Each runnable task also has a guarded **Run now** action that bypasses the
release wait and uses the current console mode. Known-drop tasks have a
**Create Windows task** action that registers a `-WakeToRun` task for the
target's local release time, using a 10-minute warm-up and three bounded
availability attempts. Both actions require browser confirmation. Windows task
registration also requires local PowerShell permission to register a task.

```sh
# Live console on the default port
npm run opentable:ui

# Dry-run console on a different port
npm run opentable:ui -- --port 8891 --dry-run
```

The console needs the bridge and an eligible OpenTable tab running as well. For
a one-command start (and the desktop icons), see
[Desktop icons](README.md#desktop-icons) in the README:
`scripts/start-opentable.ps1` brings up the bridge, opens OpenTable in Chrome,
and starts the console together. `scripts/stop-opentable.ps1` shuts them down,
refusing while an unattended run holds the scheduler lock.

The console lets you:

- search restaurants through the paired Chrome tab with typeahead suggestions,
  then load a result into the task form (the search is a read-only page request;
  no provider internals or page state leave Chrome, only the bounded fields in
  `SafeSearchResults`);
- check live availability for a date and party size, which lists the times and
  the dining areas the restaurant actually offers. Clicking a time sets the
  preferred time, and ticking a dining area builds the allow or prefer policy
  from the provider's real labels instead of guessing at them;
- preview the exact booking terms for a candidate slot and see the fail-closed
  policy decision, including each rejection reason, before the drop instead of
  at it;
- create a task from the same `BookingTarget` fields the state file uses,
  including the dining-area policy, the fail-closed booking policy, and
  `knownReservationReleaseAt` or the cancellation-watch stop time, saved as
  `DRAFT` or `ARMED`;
- run a runnable task immediately with the current Live or Dry Run mode, or
  register the Windows wake task directly from the table. The Windows action
  uses the restaurant profile URL captured from search, or asks for it when an
  older task does not have one stored;
- edit an existing task in place. Edit reloads the record into the form and
  saves with a `PUT` guarded by the stored version, so a concurrent scheduler
  write still loses to the conflict check. Tasks that are mid-flight
  (`MATCH_FOUND` through `SUBMITTING`) or terminal (`BOOKED`,
  `OUTCOME_UNKNOWN`) cannot be edited, and an edit never changes a task's state;
- arm, pause, and delete tasks, each guarded by the stored record version so a
  concurrent scheduler write cannot be clobbered;
- watch bridge reachability, session authentication, the booking mode, and the
  last scheduler pass.

Both the availability check and the terms preview are reads. They run
`findSlots` and `getBookingPreview` under a probe policy with
`autoBookAuthorized: false` and zero spending caps, so neither can authorize or
submit a reservation no matter what the page returns.

The availability check replays the restaurant page's own availability request,
so the paired Chrome tab must have visited that restaurant page first. If the
probe answers "The RestaurantsAvailability operation has not been observed on
this page", open the restaurant in Chrome and probe again.

The embedded scheduler ticks on the same interval as the CLI and never overlaps
passes. It uses the same readiness gate as the CLI, so a run pauses rather than
firing at a browser that is not there. The console starts in Live mode. Use the
header control to switch to Dry Run before testing; switching to Live requires
confirmation because armed tasks may submit real reservations.

The console deliberately does not hold the unattended scheduler lock, so leaving
it open can never block a scheduled drop. When an unattended run does own the
drop, the console skips its own passes and says so in the status line.

The server binds to `127.0.0.1` only, mutations must be same-origin JSON
requests (so a cross-site HTML form cannot reach them), and nothing is exposed
beyond the loopback socket.

## Registering the scheduled task

From an elevated PowerShell prompt, three minutes of warm-up is added automatically:

```powershell
.\scripts\register-scheduled-task.ps1 `
  -RestaurantUrl "https://www.opentable.com/r/don-angie-new-york" `
  -DropTime "10:00" `
  -DropDate "2026-11-08" `
  -TargetId don-angie
```

Omit `-DropDate` for a recurring daily warm-up. The task is registered with
`-WakeToRun` so an idle machine wakes for the drop. Remove it with
`Unregister-ScheduledTask -TaskName OpenTableBot-Drop`.

Pass `-DryRun` when registering a non-submitting task.

## Unattended startup

You do not have to keep Chrome or the bridge open. The registered task starts
`run-scheduled.ps1` `WarmUpSeconds` before the release time, and that script:

1. opens the restaurant page in your normal signed-in Chrome profile, which
   also starts the MV3 service worker so the extension reconnects to the bridge;
2. starts the local bridge if nothing is listening on the bridge port;
3. runs the scheduler, which waits for readiness before the drop.

Readiness means the bridge answers `PING` with both `extensionConnected: true`
and `pageReady: true`, so the extension is paired *and* an eligible OpenTable
page is bound. The scheduler polls readiness through the whole warm-up window
(`--readiness-seconds`, default 180), so a machine that just resumed has time
for Chrome to launch and the service worker to wake.

If the browser is still not ready at the release time, the target is paused with
the reason instead of being run against a page that is not there:

```text
Browser was not ready at the release time (extension not connected, no eligible OpenTable page)
```

That pause is deliberate. The drop has passed, the inventory cannot be reached,
and a clear paused state is more useful than a confusing adapter failure.

Two things still require a human once:

- **Chrome must be signed in to OpenTable** in the profile the script opens.
  Sign-in, challenges, and CAPTCHAs are never automated.
- **The restaurant page must load normally.** The availability probe replays the
  page's own request, so the tab has to reach a real restaurant page rather than
  a challenge or an error page.

### Only one unattended scheduler at a time

An unattended run takes an exclusive lock at
`.local/state/scheduler.lock` (process id, owner, and acquisition time). A second
unattended run refuses to start and names the holder, so two processes never race
the same targets through the same drop. A lock left behind by a crashed or
powered-off process is detected as stale and taken over automatically.

The operator console never takes that lock. Instead it reads it and stands down
while an unattended run owns the drop, reporting why in the status line. That
means leaving the console open cannot block a scheduled drop.

## Notifications and logs

Every state change, pause, and confirmation is printed and appended as one JSON
line to `.local/logs/notifications.log` (override with
`OPENTABLE_BOT_LOG_DIRECTORY`). No network egress is involved.

The pause reason in a notification stays a one-line summary. The full evidence
for an availability decision lives in the target record's `availabilityDetail`
field in the state file, and the console renders it under the task's status as
an expandable "Availability detail" section with one row of chips per attempt.

## Status

The scheduler, store, and notifier are implemented and unit-tested. **No
scheduled live write has completed yet.** Verify one supervised booking with
`npm run opentable:book -- ...` before relying on an unattended run.
