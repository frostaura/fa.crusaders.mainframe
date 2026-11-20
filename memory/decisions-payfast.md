---
name: crusaders-mainframe-decisions-payfast
description: "PayFast trust: a club without a passphrase is not configured, an ITN credits only after signature, merchant, COMPLETE, PayFast's validate and the locked amount, once per checkout by the database; a second payment is flagged, never absorbed."
type: decision
last_verified: 2026-11-20
---

# Live decisions — PayFast: what an ITN must prove, and money going back

Spec `docs/specs/payments-payfast.md` (Receiving an ITN, Configuration, Money going back). Code
`Endpoints/TopUpEndpoints.Itn.cs`, `Payments/PayFast/{PayFastCredentialRules,PayFastItnChecks}.cs`,
`Endpoints/AdminPaymentEndpoints.cs`, `Endpoints/WalletEndpoints.Reversal.cs`. From the 2026-11-13 money pass (findings
BM-1…13, BP-01, all reproduced before the fix). PayFast has never processed a real transaction ([`watch.md`](watch.md)).

- **PayFast replaced PeachPayments; the `IPaymentProvider` seam survived** ([`decisions.md`](decisions.md)). It signs MD5
  over a PHP-`urlencode`-compatible string (spaces as `+`, uppercase hex), which .NET's escaping does not reproduce, and
  money is formatted with `InvariantCulture` (`PayFastProvider.cs:90`) — the signature corpus is `src/contracts/payfast`.
- **A club without a passphrase is not configured for payments** (outside Development), nor one whose merchant id is not
  8 digits or key not 13 alphanumerics, nor any `REPLACE_` placeholder; a passphrase under 12 characters is refused
  (offline brute force). *Why:* with no passphrase the signature is an MD5 of fields the member's checkout form shows,
  and a forged `COMPLETE` credited 300 minutes, live. The shape rules are PayFast's own refusal text, so they lock out
  nobody PayFast accepts. **Manual step owed at the next redeploy:** a stored passphrase that is blank or a placeholder
  now reads as not configured — enter it under Settings › Money & packages › PayFast account ([`state.md`](state.md)).
- **An ITN moves money only after:** the signature, the club's `merchant_id`, a `COMPLETE` carrying `pf_payment_id` and
  `amount_gross`, PayFast's `/eng/query/validate` answering `VALID`, and the locked amount. Validation unreachable is
  `503` so PayFast retries. **The source check is advisory by default** (`PayFastSourceCheck`, `PayFast:SourceCheck`,
  `PayFastItnChecks.cs:167-254`; reads `PayFastProvider.KnownSourceHosts` and the published ranges; enforceable by
  configuration) because a proxy that hides the peer would refuse every genuine ITN.
- **One checkout is credited once, by the DATABASE**: a conditional `Pending→Completed` UPDATE under the payer lock plus
  `ledger_entries.PurchaseId` unique per club (`AddLedgerPurchaseId`; `MainframeDbContext.cs:744`). *Why:* each ITN built
  its own reference from its own `pf_payment_id`, so 8 concurrent ones credited 3×.
- **A second genuine payment is flagged, never "idempotent"** (`paid_twice` / `paid_after_close` admin notice + member
  mail, `200`). Its rand is on no ledger row; the desk sells or refunds by hand.
- **Credentials are set from the console**, `GET/PUT /api/v1/admin/payments/payfast` (Settings › Money & packages): passphrase
  write-only, change record `payments.payfast_updated` (set / changed / cleared only). The money lane owns this surface;
  the operator CLI deliberately has none (two writers were avoided). The dev seeder writes PayFast's published sandbox
  merchant and a random passphrase, so the e2e harness sets its own. Merchant credentials sit **in clear** in
  `tenant_settings` (`TenantSecretsAccessor.cs` defers a KEK to unbuilt work) — [`watch.md`](watch.md).
- **Rand given back is a `PaymentReversal` naming the purchase** (`ReversesEntryId`, `AddLedgerReversesEntryId`,
  filtered index `:746`), via `POST /admin/minutes/{id}/reverse-payment`; the total is capped at the purchase's rand and
  minutes under the payer lock. Revenue signs a reversal's rand as given back even with 0 minutes, summed in SQL. *Why:*
  nothing posted one, so Revenue kept every refund. The desk sheet: [`decisions-desk-money.md`](decisions-desk-money.md).
- **Top-up admin notices carry only what the club can act on** (`TopUpAlerts.cs:32-58`, `:61-64`): a failed
  purchase's `amount_mismatch`, `gateway_error` or `provider_register_failed`; from the ITN route `signature_invalid`,
  `merchant_mismatch`, `source_unrecognised` and `validation_failed` (one per club per UTC day: the route is
  anonymous), `payment_id_missing` (a member who HAS PAID and is still `Pending`), `amount_missing` (per purchase),
  `paid_twice` and `paid_after_close`. A decline or a member's cancel never reaches admins (the member is mailed) —
  [`decisions-admin-notices.md`](decisions-admin-notices.md). *Corrected 2026-11-20:* the list read as exhaustive at five.
