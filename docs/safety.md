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
- **Which network:** the one the command actually travels on (`driver.network(light)`). A Govee
  light over the LAN driver draws from nothing shared; through HA it draws from `govee_cloud`.
  A state the chosen driver can't carry (a Govee scene) goes through HA (the `fallback`).
- **Batches** (`send_many(lights, state)`): every light still gets its own slot, so per-light
  rates, priorities and latest-value-wins hold. When a light's turn comes, its worker claims the
  other lights of the batch that are due and on the same driver; the driver splits them into
  messages (Z-Wave multicast by security class, z2m groups that match exactly), and **each
  message takes one token**. After the token wait, lights that got a newer command meanwhile
  are left out, so a stale batch value never overwrites a newer one.
- **Frames a driver sends on its own** (Z-Wave read-backs after a multicast, and the unicast
  resend to a node that missed it) take tokens from the same budget
  (`Governor.network_token()`).
- `cancel_all(below=…)` drops waiting commands (used by Stop all).

The load test (`tests/test_load.py`) hammers eight Z-Wave dimmers for 1.5 s (a command every
~20 ms, some to all eight at once) through the real Z-Wave driver and a fake Z-Wave JS server
with the real budget. Every window of frames the server sees stays within 2 + 2/s × its length,
and every dimmer ends at the last value asked of it.

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

Every HA service call returns HA's context id (direct drivers return none, so only the second
check below applies to them; see the known limits in [drivers.md](drivers.md)). A `state_changed` for a touched light is **ours** if
its context id is one we got back, or if it matches what we last asked for (same on/off, and
brightness within 51/255). HA gives device reports that arrive more than ~5 s after a call a new
context, so the second check stops those being mistaken for someone else's change.

Reports that arrive while a command is still **settling** don't count either:
- for the light's latency, plus the driver's own check time (`settle_s`: Z-Wave's multicast
  read-back and correction, about 3.5 s), plus 1 s, **any** disagreeing report is ignored. On the
  real house a GE dimmer out of the stick's direct range missed a multicast; the read-back showed
  its old level, and before this window that was taken for a person, so the light was dropped and
  never restored;
- for the rest of a fade, a level in between is expected, but an **on/off flip** that disagrees
  still counts as a person (a wall switch turning a light off mid-palette).

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
lights at once (`send_many`: one Z-Wave multicast or z2m group message where the lights allow
it), all restored together. A light in a fixture can't be tested on its own.

For checking drivers, the Test API takes options (`TestOptions`): a fade `transition_ms`
(0–10000) on the way on and off, an `effect` while on (one the light lists) and `hold_s` (0–30).
Same snapshot and restore. The activity entry names the driver used ("Testing … via z2m").

## Read-only mode

`read_only` (add-on option, or forced for any PC run against a real HA) makes
`HAClient.call_service()` and every direct driver's `set`, `set_batch` and `stream` raise
`ReadOnlyError`, so nothing can reach a light. Direct drivers still discover (reads only).

Direct drivers are **off unless switched on**: `DriverSettings()` enables none. The add-on's
options switch them on (all by default there); tests and PC runs never sweep the real LAN unless
they ask for it (`LUMINORIUM_DRIVERS`). The UI shows a banner
and disables Test.
