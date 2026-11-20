---
name: crusaders-mainframe-decisions-lights-cues-reversal
description: "A late check-in's reversal lights cues: on/off a pair or nothing, the consumer ordering rule, and one instant per lighting — stamped at emission only when an off was already said after the scan."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the lights cues of a reversal, and when an on is stamped

The rest of the mirror (one source, the cue lock, next-free offs, lit cancellations):
[`decisions-lights-cues.md`](decisions-lights-cues.md). Code: `Services/CourtActivationService.cs`, `Webhooks/LightsCueWorker.cs`.

- **Reversal on/off are a pair or nothing** (R14 E14-4, narrowed R15 D15-2): the reversal's on is suppressed only when a
  holder was lit AT the scan (`LitFrom(holder) <= scan`); if the holder lit later, the on is sent at the scan and the
  holder's off closes the court. The reversal is cue-stamped (`LightsOffCuedAt` ≥ `NoShowReversedAt`) either way, so the
  attended-and-over pass owes no second off. *Why:* the restored end IS the survivor's start, so R14 always suppressed,
  and an on stamped at the scan arriving after the survivor's never got an off. A reversal AFTER the off cue gets one
  more `lights_off` at the restored end (`CompleteAttendedAsync` restamps `LightsOffCuedAt`).
- **Consumer rule that covers what source cannot:** order by `occurred_at`; an off that ARRIVED before the on of the
  same booking does not close that on (the no-show sweep's off was said before the upload reversed it).
- **One instant per lighting** (R19 E19-2): `occurred_at` of every `booking.lights_on` is the scan instant the Night
  prints (`data.scanned_at` = it), UNLESS an off for the court was already said after the scan and the session still
  runs — then it is stamped at emission (`ReversalOnAtAsync`, `CourtActivationService.cs:496,608`; R16 E16-2), so a
  consumer ordering by `occurred_at` never reads the court dark after an off. **"Already said"**
  (`OffSaidAfterAsync`, `:636-641`): the booking's own `LightsOffCuedAt` after the scan, or another booking on the
  court cued off whose `EndsAt` is after the scan and already past. An over session keeps the scan stamp (an on
  stamped now would sort after its past off and hold the court lit for ever).
