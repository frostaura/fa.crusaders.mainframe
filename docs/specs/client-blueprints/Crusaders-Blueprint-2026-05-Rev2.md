# Crusaders Squash Booking System Blueprint — May 2026 — Rev 2

**Source:** Client (Crusaders Squash Club committee).
**Original artefact:** [`Crusaders-Blueprint-2026-05-Rev2.xlsx`](./Crusaders-Blueprint-2026-05-Rev2.xlsx) — preserved verbatim alongside this transcription.
**Received:** 2026-05-09.

This is a faithful markdown rendering of the spreadsheet content. Implementation deltas relative to the current build are tracked in [`../client-blueprint-deltas.md`](../client-blueprint-deltas.md); this file is just the source of truth for what the client asked for.

## A — Booking and Payment

> App to retain payment method detail / numbers / codes? **Discuss.**

| # | Action | Desired outcome |
| --- | --- | --- |
| A.1  | Book online via an App | App on cell phone |
| A.2  | Access to app with ID and password / thumbprint on phone | Member to be given access to app and subject to an approval by administrator |
| A.3  | Payments via Credit Card or EFT for members | Upload in blocks of R100 to a maximum of R1 000. Admin unlimited amount. |
| A.4  | Booking restriction | Booking possible with a two-week horizon and for one hour per day |
| A.5  | Unfunded / underfunded accounts unable | These members cannot make a booking unless account is funded |
| A.6  | Admin override | Admin to have access via website and unlimited booking restrictions |
| A.7  | Booking classes set | Two booking classes — **member** and **league player / over 65's** |
| A.8  | Differential payments for league players / non-league players | Currently **R100 = 240 credits** (league / 65+), **R100 = 160 credits** (regular member) |
| A.9  | Lights credit account to be charged | Member's account to be debited **on putting lights on** |
| A.10 | Booking for league games | Booked by admin and paid for by the member |
| A.11 | Admin override capability | For purposes of control and to ensure that the system is not abused |
| A.12 | League player exclusivity | Only league players should be able to book in **peak times — 16h00 – 19h00** (unless court is free) |

## B — Access to courts / Switching on of lights

> Can we do away with cards? And use facial recognition, biometrics, or a QR code.

| # | Action | Desired outcome |
| --- | --- | --- |
| B.1 | Via biometrics / cell phone / personal code set up by individual | Linked programmed touch pads to be located outside both doors |
| B.2 | Lights to be switched on when activated | Person making booking to have ability to override to allow **someone else to pay** |
| B.3 | Booking restriction | Restriction of one hour per day **unless courts are available**, and only permissible on the day |
| B.4 | Booking period to be 15 minutes | (Slice length) |
| B.5 | Credit in account | Should an individual have insufficient credit to pay for the booking, they would have to fund their account |

## C — Analytical data required / available to admin

| # | Action | Desired outcome |
| --- | --- | --- |
| C.1 | Who has booked by name / member reference / status | Control and coordination |
| C.2 | Booking history by member | Ditto |
| C.3 | Spend by member | Ditto |
| C.4 | Monthly reports | Ditto |

## D — Control of member information

| # | Action | Desired outcome |
| --- | --- | --- |
| D.1 | Usage history | To be stored for **two years** |
| D.2 | Control of member data / information | To be managed and controlled by admin |
| D.3 | POPI Act | Ensure compliance |

## Open question from the client

> "App to retain payment method detail / numbers / codes? Discuss."

This is an open product question — the answer should be **no, the app does not store card numbers or PANs**. We rely on PeachPayments hosted checkout (the player's card never touches our servers). The merchant on file gets the saved-card capability via PeachPayments' tokenisation if the client wants one-tap top-ups. To be confirmed with the committee.
