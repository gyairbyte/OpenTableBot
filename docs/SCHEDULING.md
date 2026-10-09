# Scheduling a known drop

Phase 4 adds a bounded known-drop scheduler. You describe a target (restaurant,
date, party, exact preferred time, and the release time), and the scheduler warms
up before the release, waits for the drop, and makes exactly one attempt.

## What the scheduler does and does not do

- It selects **only** a slot at the target's exact `timeWindow.preferred` time.
  If that time is absent, it pauses the target and notifies instead of taking a
  nearby time.
- It runs **once**. There is no post-drop retry loop.
- Ambiguous submissions become terminal `OUTCOME_UNKNOWN` and are never retried.
- Any challenge, sign-out, access denial, or failure pauses the target and logs it.
- `--execute` is required for a real booking. Without it the run is a dry run.

## Prerequisites

- Node.js 22 and dependencies installed (`npm ci`).
- The extension built (`npm run extension:build`) and loaded unpacked in Chrome.
- Chrome paired to the local bridge (`npm run opentable:bridge -- pair`).
- The machine is on and Chrome can be launched with the signed-in profile.
- The target exists in the state file (see below).

The scheduler does **not** launch Chrome. Task Scheduler does, via
`scripts/run-scheduled.ps1`, which also opens the restaurant page so the
extension's content scripts load and capture the page's availability operation.

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
          "maxAuthorizedPrepaidCents": 0,
          "maxAuthorizedCancellationNoShowCents": 0,
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
# Dry run against every runnable target
npm run opentable:schedule

# One target, real booking
npm run opentable:schedule -- --target-id don-angie --execute
```

Options:

- `--target-id <id>` restricts the run to one target.
- `--execute` performs the real lock and submission.
- `--tick-seconds <n>` polling interval while waiting for a drop (default 5).
- `--max-runtime-minutes <n>` upper bound before exiting (default 30).

The scheduler warms up 60 seconds before `knownReservationReleaseAt`, polling
`AUTH_STATUS` until the page is ready, then waits for the release time and runs
once.

## Operator console

`npm run opentable:ui` starts a loopback HTTP console on
`http://127.0.0.1:8790` that drives the same store, engine, and scheduler as the
CLI. It accepts the same flags as the scheduler for `--tick-seconds` and
`--execute`, plus `--port <n>`.

```sh
# Dry-run console on the default port
npm run opentable:ui

# Write-enabled console on a different port
npm run opentable:ui -- --port 8891 --execute
```

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
  `knownReservationReleaseAt`, saved as `DRAFT` or `ARMED`;
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
passes. Mode is fixed when the process starts: a dry-run console cannot submit a
reservation, so restart with `--execute` to enable controlled writes.

The server binds to `127.0.0.1` only, mutations must be same-origin JSON
requests (so a cross-site HTML form cannot reach them), and nothing is exposed
beyond the loopback socket.

## Registering the scheduled task

From an elevated PowerShell prompt, one minute of warm-up is added automatically:

```powershell
.\scripts\register-scheduled-task.ps1 `
  -RestaurantUrl "https://www.opentable.com/r/don-angie-new-york" `
  -DropTime "10:00" `
  -DropDate "2026-11-08" `
  -TargetId don-angie `
  -Execute
```

Omit `-DropDate` for a recurring daily warm-up. The task is registered with
`-WakeToRun` so an idle machine wakes for the drop. Remove it with
`Unregister-ScheduledTask -TaskName OpenTableBot-Drop`.

## Notifications and logs

Every state change, pause, and confirmation is printed and appended as one JSON
line to `.local/logs/notifications.log` (override with
`OPENTABLE_BOT_LOG_DIRECTORY`). No network egress is involved.

## Status

The scheduler, store, and notifier are implemented and unit-tested. **No
scheduled live write has completed yet.** Verify one supervised booking with
`npm run opentable:book -- ... --execute` before relying on an unattended run.
