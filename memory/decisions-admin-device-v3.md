---
name: crusaders-mainframe-decisions-admin-device-v3
description: "The console half of device contract v3 (2026-11-13): Boards' remote-fix panels, per-board screen, hardware and health, the member-code rollout, served-only bounds, and the field names the console reads."
type: decision
last_verified: 2026-11-13
---

# Decisions — the admin console for device contract v3 (lane frontend-admin, 2026-11-13)

Founder rulings that bind it: the next USB flash is the last; nothing an operator does may force a
reflash; the backend is the source of truth for hardware state. So every lever an operator needs
after that flash is on Boards or in Settings — never a cable, never a raw API call.

- **Every v3 panel is presence-gated and three-stated** (`components/devices/useServedRead`):
  reading, failed (a failure, never an empty answer), data — and a `404` means "this API has no
  such route", so the panel is absent rather than empty. A reply of the wrong shape is a failed
  read. *Why:* the console ships ahead of the backend lane; a panel bound to nothing would invent
  a board's state.
- **Bounds and enumerations are the API's alone** (`bounds` on the settings GET, FA-2/BA-05): no
  box/device row carries a client range, and the `hw_*` selects carry no client values — without
  served values a select offers only what the club holds. Numeric enumerations (LCD address,
  scanner baud) are `numericChoice`: strings on screen, numbers on the PUT. *Why:* a client copy of
  a range is exactly how 5–120 s was offered for a revert the API bounded 3–60.
- **Regenerate is gone; the key rotates** (BA-01): rotate (old key keeps working), per-board
  progress, retire early only with the old key's id typed and the stranded boards named, restore
  a known key behind a typed RESTORE (owner only).
- **Per-board overrides are three-valued like the button map** — layout, marquee and the five
  `hw_*` facts: absent = unchanged, null = the club's, a value = the board's. *Back to compact* is
  one press. The relay drive level is saved only through a confirm that says what a lit court does
  (`RELAY_LEVEL_CONFIRM`): a wrong level keeps courts dark, never lights one that should be off.
- **What a board reports is shown beside what it is set to** (`lib/deviceHardware`, `lib/deviceHealth`):
  `mega.lcd = 00` ("no screen answered"), a non-`power_on`/`software` restart, `block` < 4096,
  `stack_min` < 512 and `drift` are attention states; MCUSR and `diag.reset` are said in words. The
  `!DIAG` rises are measured from the page's first reading of each board (a counter that went down
  means the Mega restarted). "Whether a screen is stuck" is the `ceilings` rise: the Mega enforces
  the ceiling itself, so a screen cannot stay stuck — the console shows how often it had to.
- **Member codes › Rollout** reads `GET /admin/devices/member-codes` (state = held / blocked /
  clear, from the server, never inferred). Acknowledge PATCHes the board's own court list (any
  PATCH acknowledges); hold and phase moves are a settings PUT of only that key plus the version
  read just before, so a colleague's settings save is never undone.
- **Club network passwords are write-only**: `psk: null` keeps the stored one, `""` is an open
  network only when ticked. The confirm names the club's `device_net_fallback_minutes`.
- **Firmware rollout is off / one board / all, pausable**; per-board progress is each board's own
  `fw_state`; the Mega is never a target. Upload reads back by target+version after a lost reply.
- **Control board**: a lit court counts down to `lights.until` (else `seconds_remaining` re-based
  on the view's `generated_at` — *not* `as_of`, which is the last event; FA-8). "Lights on, nothing
  booked" / "checked in, lights off" need the box's CONFIRMED state and the club's grace window
  (BA-04). No remote switch-off — deferred by `device-api.md` §14; the copy now says paid courts
  are put back on from the club's record, which never switches one off (FA-9, BA-27).
- **Field names the console reads, pending the backend lane** (device view): `capabilities`,
  `lcd_layout`, `lcd_marquee_enabled`, `lcd_layout_acknowledged(_at)`, `fw_state`, `fw_failed`,
  `fw_error`, `net_ver`, `net_src`, `key_id`, `restore`, the five `hw_*`, `mega`, `diag`,
  `telemetry_at`, `drift`; rollout `keys: [{id, name, keys_sent, keys_trimmed, keys_sent_at}]`;
  a door's online replay as activity reason `replayed` (MCV1-10). Types: `lib/api.ts` `AdminDevice`.

Rejected: client-side enumerations "until the API serves them" (the drift the rule exists for);
a Fullscreen-API wall view (an overlay over the app's chrome instead — a notification cannot
drop it back to the console); an inferred rollout state from the board list.
