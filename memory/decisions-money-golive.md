---
name: crusaders-mainframe-decisions-money-golive
description: "Pre-go-live money pass (2026-11-13): an ITN credits only after passphrase, merchant, amount, PayFast's validate call; one checkout once by index; refunds post PaymentReversal; PWYC only when short."
type: decision
last_verified: 2026-11-13
---

# Live decisions — the pre-go-live money pass (lane backend-money, 2026-11-13)

Spec: `docs/specs/payments-payfast.md` (Receiving an ITN, Configuration, Money going back). Code:
`Endpoints/TopUpEndpoints.Itn.cs`, `Payments/PayFast/{PayFastCredentialRules,PayFastItnChecks}.cs`,
`Endpoints/AdminPaymentEndpoints.cs`, `Endpoints/WalletEndpoints.Reversal.cs`. Findings BM-1..BM-13,
BP-01, browser BM-01/03/20/21, all reproduced before the fix.

- **A club without a passphrase is not configured for payments** (outside Development), nor one
  whose merchant id is not 8 digits or key not 13 alphanumerics, nor any `REPLACE_` placeholder.
  *Why:* with no passphrase the signature is an MD5 of fields the member's checkout form shows, and a
  forged `COMPLETE` credited 300 minutes, live. The shape rules are PayFast's own refusal text, so they
  lock out nobody PayFast accepts. A passphrase under 12 characters is refused (offline brute force).
- **An ITN moves money only after:** signature, the club's `merchant_id`, a `COMPLETE` carrying
  `pf_payment_id` and `amount_gross`, PayFast's `/eng/query/validate` answering `VALID`, the locked
  amount. The source check is **advisory by default** (`PayFast:SourceCheck`) because a proxy that
  hides the peer would refuse every genuine ITN; validation unreachable is `503` so PayFast retries.
- **One checkout is credited once by the DATABASE**: conditional `Pending→Completed` UPDATE under
  the payer lock plus `ledger_entries.PurchaseId` unique per club (`AddLedgerPurchaseId`). *Why:* each
  ITN built its own reference from its own `pf_payment_id`, so 8 concurrent ones credited 3×.
- **A second genuine payment is flagged, never "idempotent"** (`paid_twice` / `paid_after_close`
  admin notice + member mail, `200`). Its rand is on no ledger row; the desk sells or refunds by hand.
- **Credentials are set from the console**, `GET/PUT /api/v1/admin/payments/payfast`; passphrase
  write-only, change record `payments.payfast_updated` (set/changed/cleared only). The dev seeder
  writes PayFast's published sandbox merchant and a random passphrase, so the e2e harness sets its own.
- **Rand given back is `PaymentReversal` naming the purchase** (`ReversesEntryId`,
  `AddLedgerReversesEntryId`), via `POST /admin/minutes/{id}/reverse-payment`; total capped at the
  purchase's rand and minutes under the payer lock. Revenue signs a reversal's rand as given back
  even with 0 minutes, and is summed in SQL. *Why:* nothing posted one, so Revenue kept every refund.
- **Pay what you can only when short**: `409 share_affordable` when paid + spendable covers the share.
  *Why:* any partner could drop their share to 1 minute and leave the organiser covering it.
- **Booking movements are referenced by their booking, not a unique key** (CLAUDE.md invariant
  corrected). *Why not deterministic refs:* a reinstated booking may be refunded again; a unique
  `cancel:{booking}` reference would 500 a legitimate refund.
- **Bulk-cancel key is hashed** into its reference (a 199-char key overflowed the 255 column).
- **Bookings past `no_show_lookback_days` and never settled raise `booking.unsettled`** daily;
  the sweep still never settles them itself (it cannot know, that late, whether the court was played).
- **Member notices wait for an unconfirmed address** (Pending, `awaiting_verified_address`, recheck
  6 h, released by the verify/welcome link's own save, suppressed after 14 days); a suspended
  recipient is `recipient_inactive`. The two durations are delivery mechanics, so constants.
- **The organiser is mailed a decline or withdrawal** (`players.response`, not urgent); a part
  payment mails only the shortfall, whose subject says "paid 6 minutes of their 10 minutes share".
- **Trap met on the way:** a new mail template needs an `EmailCatalogue` entry named exactly as the
  method, a new mirror event needs the picker, `feature-spec.md` §9 and the blueprint (pinned by
  `RepositoryPostureTests`), and "credit" in an identifier fails `MinutesSourceScanTests`.
- **Not done here:** BM-9 (mixed wire case) needs the frontend lanes to switch reads first; the
  binding founder decisions of this pass (last physical flash, OTA, snapshot) live in the device-v3
  decisions topic, not in this lane.
