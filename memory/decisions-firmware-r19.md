---
name: crusaders-mainframe-decisions-firmware-r19
description: "Firmware round 19 (lane FW19): one ScanMemory rule for the remembered scan — tenant scan memory, whole countdowns never shortened, never past the server's age bound less 5 s, else SCAN AGAIN; bridge 2.2.9."
type: decision
last_verified: 2026-10-06
---

# Live decisions: firmware, review round 19 (lane FW19, D19-1 to D19-3, D19-5)

- **Bridge 2.2.9; Mega 2.0.0 (sketch byte-identical); door 1.1.2.** Supersedes the version line in
  [`decisions-firmware-r18.md`](decisions-firmware-r18.md).
- **THE RULE: the remembered scan is ONE object, `bridgelogic::ScanMemory`, and main.cpp never
  arms a scan deadline by hand.** *Why:* three call sites armed it by three rules and they
  disagreed — the scan used the compile-time 30 s (D19-3), a quote re-armed it to "scan memory +
  choice from the scan", which after a BUSY hold SHORTENED it below the quote's countdown so the
  confirm press went nowhere (D19-1), and each PRESS AGAIN added a whole choice window without
  limit (D19-2: the fourth busy answer sent `scan_age_ms` 86 600 against the server's 80 000 and
  the member read CODE NOT KNOWN about their own code).
  - `remember` uses the tenant's `scan_memory_seconds` (adopted per heartbeat via `setLimits`).
  - `holdForQuote` / `holdForPressAgain`: at least the choice window from now, never shortened,
    and never past `ceilingMs()` = `(scan_memory + choice) × 1000 + 30 000 − 5 000` — the
    server's `MemberCodeSettings.MaxScanAgeMs` less `kServerMarginMs`. **Whole or not at all:**
    when a whole countdown no longer fits it answers false and main.cpp's `scanAgain()` forgets
    the scan (and the quote and pad) and paints the new `ScreenId::ScanAgain` (APPENDED,
    kScreenCount 34: `SCAN AGAIN` / `Waited too long` / `Then press a court` / `SCAN WHEN READY`,
    revert hold, no court cells). *Why not a shortened countdown:* a countdown the press cannot
    outlive is a lie on the glass; a press the server refuses is worse.
  - The 5 s margin covers the pass between the loop's expiry check and the body that carries the
    age (presses are drained after the check) plus a heartbeat not yet adopted. A SHORTER setting
    adopted later clamps a held scan into the new bound at once (`setLimits(…, now)`).
  - A hold checks `remembered()`, NOT `!expired()`: the answer arrives after a blocking HTTP call
    and a scan that lapsed DURING it was alive at the press; the age bound is what limits it.
  - Every path holds BEFORE it paints the invitation, so SCAN AGAIN never follows a flashed one.
  - `forgetScan()` now also clears the pay-for quote: a quote behind a forgotten scan is a confirm
    on nobody's code. *Cost accepted:* the old "scan memory + choice from the scan" bound on the
    quote is gone; re-quotes by a passer-by are bounded by the ceiling instead (at defaults, two
    questions after the scan's own 30 s, then SCAN AGAIN).
- Red first throughout: ScanMemory tests against a verbatim port of the old rules; flags, hold
  class, cap and row-staging tests failed before each change.
- **D19-5 (spec only):** §9.1: only a 404 (any status not 200/0/429/5xx) or an unreadable 200
  falls back to the walk-up choice; 0 is NO CONNECTION, 429/5xx BUSY (as since R18 D18-3).
- **Every press invitation is held the same way.** A decided refusal whose words ask for another
  press on the same scan — the walk-up's `TOO LONG` / `TRY LESS TIME` (`WalkUpResult::invitesPress`)
  and `PRICE CHANGED` / `Press court again` (`PayForAnswer::invitesPress`) — goes through the same
  `holdForPressAgain` as BUSY: scan and Mega window held for the choice window, or SCAN AGAIN.
  `PayForPriceChanged` now counts down the CHOICE window, not the revert one. *Why:* both used to
  leave the scan where it was, so the press they asked for could land on a forgotten scan; and a
  revert countdown may be set longer than any hold the server bound allows.
- **A court-press invitation never outlives the scan** (`screenFor(id, facts, settings, scanLeftMs)`,
  via main.cpp's `screenNow`): a screen whose action row is the court cells holds at most the whole
  seconds of scan left; under one second, the cells become `SCAN WHEN READY`. *Why:* a club may set
  `lcd_revert_seconds` above `scan_memory_seconds`. Today only `SlotEnded` (pay-for `ended`) among
  NO BOOKING / SLOT ENDED / COURT IN USE / NO TIME / PURCHASE ENDED is painted — activation and
  walk-up refusals are legacy two-line `!LCD` with no cells — but the cap covers every cell screen.
- **The bridge stages every row, empty ones too** (`bridgelogic::screenFrame`). *Why:* the Mega
  commits every staged row on `!SHOW` and an unstaged row keeps the last screen's text (pinned in
  test_courtlogic): ONE MOMENT read `Press a black button` left by CHOOSE TIME.
- **Recorded, not fixable from the bridge:** the Mega holds a legacy two-line `!LCD` (TOO LONG / TRY
  LESS TIME) for its compile-time `LCD_REVERT_MS` (10 s). With `lcd_choice_seconds` below 10 the line
  can outlast the scan hold; no countdown, and a late press buys nothing. Mega is off-limits.
