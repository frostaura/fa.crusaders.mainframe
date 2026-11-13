---
name: crusaders-mainframe-decisions-device-v3-compat
description: "Device contract v3 addendum (2026-11-13): the frozen firmware must read every future server — the lifeline, tolerant readers, budgets at 80% of every buffer, every 2xx a success, real replies through real parsers."
type: decision
last_verified: 2026-11-13
---

# Decisions — forward compatibility for the frozen firmware (v3 addendum, 2026-11-13)

Taken by the orchestrator under Dean's "fix any and all" go-ahead, after four late gap reports
(FC-1…13, ESPR-1…8, HW-1…11, MCV1-01…11) that the first v3 draft never saw. Spec:
`docs/specs/device-api.md` §11 and §13; corpus `src/contracts/device-protocol/compat/`.

- **The lifeline is frozen append-only: bearer key + `key_next`, `net`, the `ota` offer and the
  firmware download.** *Why:* the Mega can never be reflashed and each ESP image is only updatable
  while those keep working; one incompatible server change there strands the fleet for good. A
  board reads them from any complete body even when the rest has drifted, and the server never
  sheds them (it would alternate a lifeline-only body first).
- **Element grammars only grow at the end; readers take the first N fields.** *Why:* 2.3.0 refused
  a roster, `relays` or key element with one extra field and then committed an EMPTY roster or key
  ring — one additive server change emptied every box (FC-1, reproduced).
- **A non-empty array of which nothing was readable keeps the previous value and reports `drift`;
  `[]` still commits empty.** *Why:* an unknown grammar must never read as "no bookings", while the
  member-code withdrawal rule (empty means withdrawn) has to keep working.
- **Known keys are read only where they live** (`button_map` only inside `config`, gate settings as
  scalars of `gate`). *Why:* a flat any-depth search let a future object placed before `config`
  hijack the panel (FC-7) and a nested object drive the lock (FC-12). `findKey` itself stays flat;
  the callers bound the read with `findObject`.
- **Exact kinds: a fraction, exponent, quoted number or negative reads as absent, never truncated.**
  *Why:* 2.3.0 read 45.9 as 45 and 4.5e1 as 4 (FC-11). The server pins integer kinds by test.
- **Every 2xx is a success; an unreadable 2xx is undecided, never a refusal.** *Why:* 2.3.0 read a
  201 walk-up as a decided refusal — charged, court dark (FC-4). Undecided keeps the scan and the
  nonce, so the retry is the same purchase. The server still answers exactly 200.
- **One budget table, `compat/` `budgets`, with every v3 server maximum at most 80% of the board's
  buffer.** *Why:* 2.x had 2048 on the server against 2559 on the box and nothing pinned the
  384/192/128-byte reply buffers (FC-3, FC-5, FC-6). v3 buffers: heartbeat 5120, scan replies 512,
  gate scan 256, events 192, request 1536. The 2.x rows are history, not reopened.
- **A v3 court box holds 64 member-code keys, written in priority order and counted when trimmed.**
  *Why:* the 24-key cap refused booked members offline (MCV1-07); keys are shed first, so they must
  be the least-needed last.
- **`make device-replay-check` runs the server's real replies through both firmwares'
  host-compiled parsers.** *Why:* the corpus holds bytes someone wrote; the live server had already
  drifted from it (19-char `server_time`, a 120 cap) and no test noticed (FC-9).
- **Every board reports `diag` (reset reason, heap, largest block, stack low-water, OTA space) and
  the box forwards the Mega's `!BOOT`/`!HW`/`!DIAG` as `mega`.** *Why:* after the last cable flash
  the heartbeat is the only window; a brown-out, a wedged LCD and a stack overflow all looked like
  "unreliable hardware" (HW-3, HW-6, ESPR-2). Floors: largest block 4096, stack 512.
- **A CI gate fails the build on stack and RAM budgets** (bridge worst path 3000 of 4096, loop frame
  256, any frame 512; gate 6000 of 8192; Mega static RAM 4096). *Why:* the bridge's worst static
  path was 3776–3968 B of a 4 KB stack before interrupts (ESPR-1); telemetry only reports a crash
  after the fact (ESPR-4).
- **Flash writes only from the top of `loop()`.** *Why:* the LittleFS write with compaction is the
  deepest stack path in the image, and v3 writes more (snapshot, events, keys).
- **The stall watchdog (6 h, link up, no accepted beat, restart when idle) is a contract constant,
  like the supervisor's timings.** *Why:* a loop that keeps yielding never trips a hardware
  watchdog (HW-8), and recovery mechanics are not club preferences.
