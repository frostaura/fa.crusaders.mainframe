---
name: crusaders-mainframe-decisions-settlement-offline
description: "How a box's offline evidence settles: scans judged at scan time (only future or 30-day-old stamps clamped), a lit cancelled booking charged the minutes its relay ran, roster codes never identify a payer."
type: decision
last_verified: 2026-11-20
---

# Live decisions — settling what an offline box saw

The ledger rules these sit beneath, including the late-evidence reversal: [`decisions-settlement.md`](decisions-settlement.md).

- **Offline scans are judged at scan time, not upload time** (cue gate, `CheckedInAt`, code liveness at `OccurredAt`);
  only a future timestamp or one past **30 days** is clamped, audited (`DeviceEventEndpoints.MaxEventAge`). *Why not
  the roster's six hours:* that bounds fetch-to-scan; the event age bounds the OUTAGE, the very thing the queue
  survives — a six-hour clamp re-created the refund-and-penalise outcome (the sweep refunding and penalising a member
  who played, which only the late-evidence reversal then undoes).
- **A cancelled booking lit offline is charged the whole minutes the relay ran, rounded DOWN** (`LitWindow.ChargeMinutes`);
  board, trace and audit show the interval rounded up (`LitWindow.Minutes`). Cancelling never expired the roster code,
  so a box in a WiFi drop lit a refunded court and nothing recovered the money. *Why two counts (P13 §12.6):* every money
  remainder stays with the payer, but a court lit 61 s WAS lit into its second minute.
- **Booking-activation codes never identify a buyer or a payer** (`IdentificationResolver`: a user only for
  `MemberIdent`) — a roster code travels in clear on the LAN and sits in box RAM for hours.
