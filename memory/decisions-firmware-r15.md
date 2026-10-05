---
name: crusaders-mainframe-decisions-firmware-r15
description: "Firmware round 15 (lane FW15): every scanned byte is escaped on the wire, the shared escaper writes 0x7F and above as \\u00XX, a 400 on an event drops it and never trips the breaker; bridge 2.2.5."
type: decision
last_verified: 2026-10-05
---

# Live decisions: firmware, review round 15 (lane FW15, D15-1)

- **Bridge is 2.2.5; Mega stays 2.0.0; door gate stays 1.1.0.** This supersedes the "bridge
  2.2.4" line in [`decisions-member-code.md`](decisions-member-code.md). The gate links the
  changed escaper but its scan assembler admits only the roster alphabet, so no byte it can send
  changes — and gate versions have never tracked shared-library changes before first flash.
- **The scanned token is ESCAPED in the activate, walk-up and pay-for bodies**
  (`bridgelogic::escapeScan` over `devapi::json::escapeInto`). *Why:* the Mega's assembler passes
  `"`, `\` and every byte above 0x7F through, and the Mega is untouchable; a bare `%s` made one
  scan an unparseable body. The event subject already went through the same escaper (G4 B1).
- **`escapeInto` writes every byte from 0x7F up as `\u00XX` (its Latin-1 code point); output is
  pure printable ASCII.** *Why:* a raw high byte is legal JSON only inside valid UTF-8, and the
  escaper cannot know what a scanner meant — a lone 0xE9 was answered 500, the drain retried the
  head event forever and the breaker read it as an outage (queue cleared only at 64 slots). The
  accepted cost: a scan that WAS valid UTF-8 (`C3 A9`) arrives as two code points. Member codes
  are ASCII, so no real code changes on the wire.
- **Body buffers are header constants the host suite renders into** — `kActivateBodyCap` 224,
  `kWalkUpBodyCap` 320, `kPayForBodyCap` 320 (was 256: an escaped 24-byte scan plus a confirm
  label is 271). *Why:* `main.cpp` is outside the native build, so a literal there was a size no
  test could hold to the worst escaped scan.
- **A 4xx on an event (400 `malformed_body` included) is drop-and-continue and closes the
  breaker** — `devapi::react` → `Rejected`, `devlink::isTransportFailure` false. Unchanged code,
  now pinned in the shared suites. Only 0/408/429/5xx and 401/403 keep the event. The server
  half (400 instead of 500) is BE15a's.
- **Corpus:** `http/cases.json` carries four `*-escaped-scan` / `-escaped-subject` vectors with
  `token_hex`/`subject_hex` = `51225c58e9ff` (Q " \ X 0xE9 0xFF); requests 7 → 11.
