---
name: crusaders-mainframe-decisions-firmware-r19
description: "Firmware round 19 (lane FW19): one ScanMemory rule for the remembered scan — tenant scan memory, whole countdowns never shortened, never past the server's age bound less 5 s, else SCAN AGAIN; bridge 2.2.9."
type: decision
last_verified: 2026-10-06
---

# Live decisions: firmware, review round 19 (lane FW19, D19-1 to D19-3, D19-5)

- **Bridge is 2.2.9; Mega stays 2.0.0 (court_mega sketch byte-identical, not reflashed); door gate
  stays 1.1.2** (no shared library changed). Supersedes the version line in
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
    adopted later clamps a held scan into the new bound at once (`setLimits(…, now)`); a longer one
    never extends it.
  - A hold checks `remembered()`, NOT `!expired()`: the answer arrives after a blocking HTTP call
    and a scan that lapsed DURING it was alive at the press; the age bound is what limits it.
  - The walk-up path holds BEFORE `applyOutcome` paints BUSY, so SCAN AGAIN is never preceded by a
    flashed press invitation; the confirm path holds before re-arming the quote.
  - `forgetScan()` now also clears the pay-for quote: a quote behind a forgotten scan is a confirm
    on nobody's code. *Cost accepted:* the old "scan memory + choice from the scan" bound on the
    quote is gone; re-quotes by a passer-by are bounded by the ceiling instead (at defaults, two
    questions after the scan's own 30 s, then SCAN AGAIN).
- Red first: the five ScanMemory tests ran against a verbatim port of main.cpp's three old rules
  and failed (outlived 20 s memory; scan forgotten under the quote; quote cut 115 s to 20; hold past
  the bound; shorter settings ignored), then green on every clock base and six setting pairs.
- **D19-5 (spec only):** §9.1 now says only a 404 (any status not 200/0/429/5xx) or an unreadable
  200 falls back to the walk-up choice; 0 is NO CONNECTION and 429/5xx BUSY — as the code has done
  since R18 D18-3. §4.2 records the ScanMemory bound.
- **Not fixed, recorded:** refusals that invite a press without re-holding the scan
  (`PayForPriceChanged` "Press court again", `MinutesOutOfRange` "Press less time") leave the scan
  where it was; a press after it lapses buys nothing (the Mega's window closes with the scan) —
  no money or age effect, so out of D19's class; a rescan works.
