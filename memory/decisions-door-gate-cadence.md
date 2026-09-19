---
name: crusaders-mainframe-decisions-door-gate-cadence
description: "How often the door gate speaks and what a refusal costs it: the 15 s floor under a flapping link, the scan bound that covers both uploads, and what a 403 or a 404 on each device path does to the roster and the queue."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's cadence and its refusals

The pass these share is in [`decisions-door-gate-loop.md`](decisions-door-gate-loop.md); the
call they make is in [`decisions-door-gate-http.md`](decisions-door-gate-http.md).

- **The member at the door wins the pass, but bounded — against BOTH uploads.** A scanner
  streaming forever would otherwise win every pass; after `kMaxScanPassesBeforeUpload` (4)
  consecutive passes in which a scan took the call with an upload waiting, the upload goes
  first (heartbeat before drain). G2 bounded the heartbeat ALONE and G3 measured what that
  left: a scan offered every 210 ms kept the heartbeat at 116/h and the drain at **0 posts
  in an hour**, so a door back from a night offline held entries nobody ever saw while its
  ring overwrote them. The counter is cleared by whichever upload takes the pass and by a
  link drop. What the fifth member waits is one whole blocking call plus the pass tick —
  **12 010 ms**, not the "ten milliseconds" four documents said (measured 8 081 ms against
  an 8 s heartbeat).
- **No heartbeat is ATTEMPTED within `kMinHeartbeatSpacingMs` (15 s) of the previous ATTEMPT**
  (G3). A link-up edge arms one for "now" — right, because the heartbeat is what fills the
  roster — which on a door at the edge of the AP's range is one call per pass: measured
  **179 999 heartbeats in a simulated hour** against a cadence of 120, and 51 429 with 50 ms
  of latency. The floor bounds it at 240/h. From the ATTEMPT, not the success, because a
  flapping radio is what produces failing calls; equal to `devlink::kMinHeartbeatMs` so it can
  never make the board disobey a pushed cadence.
- **A 403 on ANY of the three device paths commits an EMPTY roster** — scan, heartbeat and event
  drain alike (G2). Two of the three did; a claim probe on the README sentence found the third.
  Denying only the scan in front of you leaves the next link drop admitting every rostered member
  for the rest of the staleness window. *Measured cost of a SPURIOUS one:* the offline fallback
  is dead for one heartbeat interval — 30 020 ms at the default cadence, 300 020 ms at the
  longest the server may push — then the next accepted heartbeat refills it.
- **A 404 on `/events` KEEPS the event** (G3), paced by the drain's backoff. `devapi::react`
  classes it `Rejected` — "a 4xx this box caused, drop it" — which is right for the court box
  and is SHARED, so the gate's drain has its own rule instead. On this route a 404 means the
  device row was deleted; the board re-registers on its next heartbeat and the same event is
  then accepted, so dropping the backlog threw away an evening of entries to save twelve
  requests an hour.
