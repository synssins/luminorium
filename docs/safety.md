# Safety: rates, snapshots and restore

Luminorium runs in a lived-in house, so the rule is: **leave things as they were, never flood a
network, never fight a person.**

## The rate governor (`engine/governor.py`)

Every command to a light goes through `Governor.send(light, state, priority=…)`.

- **Per light:** commands are at least `1 / profile.max_rate_hz` apart.
- **Latest value wins:** a new command replaces one still waiting for the same light; the
  replaced caller gets `Superseded`. Nothing queues behind a slow light.
- **Priorities:** `AMBIENT < SHOW < SAFETY < RESTORE`. A lower-priority command never replaces
  a higher one. `SAFETY` and `RESTORE` skip the per-light wait.
- **Network budgets** (token buckets, all priorities): Z-Wave 2/s (burst 2), Zigbee 25/s (burst
  10), Govee cloud 1/s (burst 2), Matter 5/s (burst 5).
- **HA driver budget:** 10 calls/s across all lights (burst 10).
- `cancel_all(below=…)` drops waiting commands (used by Stop all).

## Sessions and snapshots (`engine/safety.py`)

- A **session** is one running thing (today: a test; later: shows). It owns asyncio tasks.
- The first time a session commands a light, its current state is **snapshotted** and written to
  `/data/snapshots.json` before the command goes out.
- A light belongs to one session at a time; another session gets `LightBusy`.
- `end_session(restore=True)` cancels the session's tasks and restores its lights.

## Stop all

`Safety.stop_all()` (UI button, `POST /api/stop_all`):
1. drops every waiting command below `RESTORE`
2. cancels every session's tasks and waits for them
3. restores every touched light at `RESTORE` priority
4. clears the snapshots

## After a crash

At startup, once the inventory is loaded, `restore_leftovers()` reads `snapshots.json` and
restores those lights. In read-only mode the file is kept and nothing is sent.

## Changes made by someone else

Every service call returns HA's context id. A `state_changed` for a touched light is **ours** if
its context id is one we got back, or if it matches what we last asked for (same on/off, and
brightness within 51/255). HA gives device reports that arrive more than ~5 s after a call a new
context, so the second check stops those being mistaken for someone else's change.

Anything else (a wall switch, an automation, the HA app) means a person changed it: the light is
dropped from its session, its snapshot is deleted, and **it is not restored**: their change stands.
`unavailable` and `unknown` states are ignored.

## The Test button (`engine/testlight.py`)

Only for included, available lights and switches that aren't in use. Sequence, as session
`test:<entity_id>`:
1. on at full brightness (`transition: 0` where supported), hold 2 s
2. off, hold 2 s
3. restore the snapshot

A relay's toggles are 5 s apart (its rate limit), so testing one takes longer.

A **fixture** is tested as one: session `test:<fixture id>`, each step sent to all its testable
lights at once, all restored together. A light in a fixture can't be tested on its own.

## Read-only mode

`read_only` (add-on option, or forced for any PC run against a real HA) makes
`HAClient.call_service()` raise `ReadOnlyError`, so nothing can reach a light. The UI shows a banner
and disables Test.
