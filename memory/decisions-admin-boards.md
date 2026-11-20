---
name: technologies-crusaders-squash-control-system-decisions-admin-boards
description: "The console's Boards and fault surfaces: v3 panels presence-gated and three-stated, bounds from the API only, key rotation not Regenerate, three-valued per-board overrides, reported beside set, fault words keyed on the server's constants."
type: decision
last_verified: 2026-11-20
---

# Decisions — the admin console for boards, faults and the rollout

Founder rulings that bind it (2026-11-13/14): nothing an operator does may force a reflash; the backend is the source
of truth for hardware state; no board updates over the air, so a firmware change is a cable flash. Every other lever an
operator needs is on Boards or in Settings — never a cable, never a raw API call. The control board's tiles:
[`decisions-control-board.md`](decisions-control-board.md).

- **Every v3 panel is presence-gated and three-stated** (`components/devices/useServedRead`): reading, failed (a failure,
  never an empty answer), data — a `404` means "this API has no such route", so the panel is absent rather than empty; a
  reply of the wrong shape is a failed read. *Why:* the console ships ahead of the backend; a panel bound to nothing
  would invent a board's state. A board with nothing v3 to say keeps its versions in its identity line.
- **The wire is pinned against the server's source** (`lib/deviceV3Wire.contract.test.ts`): the ironclad integration
  found the console and API disagreeing on `restore`/`restore_report`, `device_id`/`rollout_device_id`, release board
  counts, the rollout's per-board `keys` and `blocks`, and the typed confirm phrases (the API compares `retire the old
  key` / `restore this key`) — stubbed vitest suites were green on all five. Types: `lib/api.ts` `AdminDevice`.
- **Bounds and enumerations are the API's alone** (`bounds` on the settings GET): no box/device row carries a client
  range, and the `hw_*` selects carry no client values — without served values a select offers only what the club holds.
  Numeric enumerations (LCD address, scanner baud) are `numericChoice`: strings on screen, numbers on the PUT. *Why:* a
  client copy of a range is exactly how 5–120 s was offered for a revert the API bounded 3–60. Rejected: client-side
  enumerations "until the API serves them".
- **Regenerate is gone; the key rotates** (BA-01): rotate (old key keeps working), per-board progress, retire early only
  with the stranded boards named and the phrase typed, restore a known key behind a typed phrase (deployment owner only,
  [`decisions-device-v3-backend.md`](decisions-device-v3-backend.md)).
- **Per-board overrides are three-valued like the button map** — layout, marquee and the five `hw_*` facts: absent =
  unchanged, null = the club's, a value = the board's. *Back to compact* is one press. The relay drive level is saved only
  through a confirm that says what a lit court does (`RELAY_LEVEL_CONFIRM`): a wrong level keeps courts dark, never lights
  one that should be off.
- **What a board reports is shown beside what it is set to** (`lib/deviceHardware`, `lib/deviceHealth`): `mega.lcd = 00`
  ("no screen answered"), a non-`power_on`/`software` restart, `block` < 4096, `stack_min` < 512 and `drift` are
  attention states; MCUSR and `diag.reset` are said in words; `!DIAG` rises are measured from the page's first reading of
  each board (a counter that went down means the Mega restarted). "Whether a screen is stuck" is the `ceilings` rise: the
  Mega enforces the ceiling itself, so a screen cannot stay stuck — the console shows how often it had to.
- **Member codes › Rollout** reads `GET /admin/devices/member-codes` (held / blocked / clear, from the server, never
  inferred); Acknowledge PATCHes the board's own court list (any PATCH acknowledges); hold and phase moves are a
  settings PUT of only that key plus the version read just before, so a colleague's save is never undone.
- **Club network passwords are write-only**: `psk: null` keeps the stored one, `""` is an open network only when ticked;
  the confirm names the club's `device_net_fallback_minutes`. Dead residue: the console still words `net_src: "local"`
  (`lib/deviceV3Copy.ts:161,220`), which no board sends since the hotspot left.
- *Superseded 2026-11-14:* the firmware rollout and upload panel (`FirmwarePanel`, deleted `c307583f`); a board's status
  line names the firmware it runs and nothing about an update.
- **Fault words are keyed on the server's constants verbatim** (`lib/deviceFaultCopy.ts`): `malformed_body`'s two kinds —
  read-anyway (`DeviceBody.ReplacedDetail`, its own title) and dropped (`NotJsonDetail`, too large) —
  `VersionTooLongDetail`, and the two-board detail (`TWO_BOARDS_DETAIL`, `BOARDS_NAMED`: "named more than one board", the
  " (boards named: a, b)" suffix parsed off any detail and listed, "filed against neither"; a suffixed row's title is the
  console's, since `HeadlineOf`'s EndsWith does not see past it). `deviceFaultCopy.r16.test.ts` holds a copy of each server
  string, so a server rewording fails it. The server's `HeadlineOf(code, detail)` titles every other kind; the client
  titles only rows with no headline or filed before `d151a964` (`legacy` in `BODY_FAULT`). No U+FFFD / UTF-8 / JSON jargon
  on the page. A clamped-clock claim reads "The board gave it <when>, so it was recorded at the time it arrived instead"
  (`claimedLine`, recognising legacy saturated instants); a fault instant shows its year when it differs from the club's.
- Rejected: a Fullscreen-API wall view (an overlay over the app's chrome instead — a notification cannot drop it back to
  the console); an inferred rollout state from the board list.
