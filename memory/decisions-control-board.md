---
name: crusaders-mainframe-decisions-control-board
description: "Which court box a control-board tile reports when several claim one court, and how the duplicate is surfaced to the console rather than silently resolved (review round 3, A-11)."
type: decision
last_verified: 2026-09-30
---

# Live decisions — the control board's box per court

Code: `Services/ControlBoardReader.cs`. Tests: `ControlBoardHttpTests`, `R3ControlBoardBoxesHttpTests`.

- **A tile reports the freshest ENABLED box claiming its court** (latest `LastSeenAt`, then device
  code). Only when no enabled box claims it does the tile fall back to the freshest of the rest,
  so a board taken out of service still reads `out_of_service`. *Why:* it took the first row the
  database returned — a box replaced 22 hours earlier — and the tile contradicted its own light
  state ("last reported 16:50" beside "not reporting · 22h ago").
- **Every tile carries `boxes_on_court`** (enabled boxes claiming the court) **and `other_boxes`**
  (`device_id`, `device_code`, `name`, `last_seen_at` of the enabled ones not reported). Both are
  additive. *Why:* two enabled boxes on one court is a commissioning or wiring mistake — two relay
  banks answering for one set of lights — and the board is a mirror: it must show the duplicate
  for the console to warn about, not choose between them and hide it.
- The query budget is unchanged (still six); the choice is made in memory from the device list.
- **The console's tile says it** (lane F3, `duplicateBoxesWarning` in `lib/monitoringCopy.ts`): how
  many boxes are set to the court, which one the tile follows and why, the others with when each
  was last heard, and to take the extras out of service on Boards. Nothing for one box.
- **Round 4 (A4-5):** the payload also lists every court box once (`boxes`: code, name, MAC, link,
  courts), so "boxes not calling in" counts boxes, not tiles; tiles and `other_boxes` carry
  `mac_address`, because every auto-registered box is named "Court box". Same six queries.
