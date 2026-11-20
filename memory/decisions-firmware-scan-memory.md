---
name: crusaders-mainframe-decisions-firmware-scan-memory
description: "The bridge's remembered scan is one ScanMemory object: tenant scan memory, whole countdowns never shortened, never past the server's age bound less 5 s, else SCAN AGAIN; an undecided answer is BUSY / PRESS AGAIN and keeps the scan."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the remembered scan, and an answer that decided nothing (rounds 17–19)

Court-box bridge only (`court-box/lib/bridgelogic/include/bridgelogic/ScanMemory.h`). The scan-flow screens that use it:
[`decisions-bridge-scan-flows.md`](decisions-bridge-scan-flows.md).

- **THE RULE (R19): the remembered scan is ONE object, `bridgelogic::ScanMemory`, and `main.cpp` never arms a scan
  deadline by hand.** *Why:* three call sites armed it by three rules and disagreed — the scan used the compile-time
  30 s (D19-3); a quote re-armed it to "scan memory + choice from the scan", which after a BUSY hold SHORTENED it below
  the quote's countdown so the confirm press went nowhere (D19-1); each PRESS AGAIN added a whole choice window without
  limit (D19-2: the fourth busy answer sent `scan_age_ms` 86 600 against the server's 80 000, and the member read CODE NOT
  KNOWN about their own code).
  - `remember` uses the tenant's `scan_memory_seconds` (adopted per heartbeat via `setLimits`).
  - `holdForQuote` / `holdForPressAgain` (`ScanMemory.h:72,76`): at least the choice window from now, never shortened,
    and never past `ceilingMs()` (`:95`) = `(scan_memory + choice) × 1000 + 30 000 − 5 000` — the server's
    `MemberCodeSettings.MaxScanAgeMs` less `kServerMarginMs`. **Whole or not at all:** when a whole countdown no longer
    fits it answers false and `main.cpp`'s `scanAgain()` forgets the scan (and the quote and pad) and paints
    `ScreenId::ScanAgain` (`SCAN AGAIN` / `Waited too long` / `Then press a court` / `SCAN WHEN READY`). *Why not a
    shortened countdown:* a countdown the press cannot outlive is a lie on the glass; a press the server refuses is worse.
  - The 5 s margin covers the pass between the loop's expiry check and the body that carries the age, plus a heartbeat
    not yet adopted; a SHORTER setting adopted later clamps a held scan into the new bound at once (`setLimits(…, now)`).
  - A hold checks `remembered()`, NOT `!expired()`: the answer arrives after a blocking HTTP call and a scan that lapsed
    DURING it was alive at the press; the age bound is what limits it. Every path holds BEFORE it paints the invitation.
  - `forgetScan()` also clears the pay-for quote (a quote behind a forgotten scan is a confirm on nobody's code).
- **Every press invitation is held the same way**: a decided refusal whose words ask for another press on the same scan
  (walk-up `TOO LONG` / `TRY LESS TIME`, `WalkUpResult::invitesPress`; `PRICE CHANGED`, whose
  `PayForPriceChanged` counts down the CHOICE window, not the revert one) goes through `holdForPressAgain`
  like BUSY — or SCAN AGAIN. **A court-press invitation never outlives the scan** (`screenFor(id, facts, settings,
  scanLeftMs)`): a screen whose action row is the court cells holds at most the whole seconds of scan left; under one
  second the cells become `SCAN WHEN READY`. *Why:* a club may set `lcd_revert_seconds` above `scan_memory_seconds`.
- **The bridge stages every row, empty ones too** (`bridgelogic::screenFrame`): the Mega commits every staged row on
  `!SHOW` and an unstaged row kept the last screen's text (ONE MOMENT read `Press a black button` left by CHOOSE TIME).
- **An answer that decided nothing keeps the scan and reads BUSY / PRESS AGAIN** (R17 D17-4, R18 D18-3/4): a 429 or 5xx
  on a walk-up (`byStatus()` in `WalkUp.cpp`) or a pay-for confirm or quote is UNDECIDED — nonce kept, scan held, Mega
  window re-armed for a full TTL keeping its binding (`AuthPolicy::afterUndecided`), so the member's own lit court stays
  theirs to switch off and no other becomes so — and the same press retries the same purchase, which the server answers
  with the first one. SEE THE DESK had sent the member away from a retry that works. Status 0 is NO CONNECTION. A quote
  is asked only about a court the box believes TAKEN, so falling through to CHOOSE TIME had offered walk-up time on a
  court in play; a 404 or an unreadable 200 still falls through (a server that predates pay-for). An unreadable 200 on a
  confirm still reads SEE THE DESK. Spec `member-code.md` §9.1 records it (D19-5). Pay-for is no longer reachable from
  the panel at 3.1.0, but its source keeps these rules.
- **The door gate has no transient-refusal wording**: a 429/5xx on `/gate` falls back to the roster and the member gets
  its verdict at once.
- **Recorded, a Mega matter:** the Mega holds a legacy two-line `!LCD` (TOO LONG / TRY LESS TIME) for its compile-time
  `LCD_REVERT_MS` (10 s); with `lcd_choice_seconds` below 10 the line can outlast the scan hold (no countdown; a late
  press buys nothing). Fixing it is a Mega change. `kScreenCount` is 41 at the tip (`ScreenScript.h:266`; 33 at R17, 34 at
  R19 — appended, never renumbered).
