> # ⚠️ SUPERSEDED
>
> The provider is **PayFast**, by founder decision on 2026-08-22. This document describes
> PeachPayments and is kept only so the decision has something to point at.
>
> **Read [`payments-payfast.md`](./payments-payfast.md) instead.**
>
> Nothing was ever built against PeachPayments beyond an `IPaymentProvider` implementation,
> which is why the switch cost a spec rather than a migration.

# Payments — PeachPayments Integration

Top-ups are processed via [PeachPayments](https://peachpayments.com/) (ZAR). PeachPayments is the payment processor the Crusaders pilot expects; the integration is per-tenant so other tenants can use their own merchant account.

## Why PeachPayments
- South African processor with strong card and EFT coverage.
- Hosted Checkout option avoids us holding card data (PCI scope minimization).
- Webhook callbacks are well-documented.

## Per-tenant configuration
Each `Tenant` has:
- `peach_entity_id` — PeachPayments merchant entity ID (per-currency).
- `peach_access_token` — server-to-server bearer token.
- `peach_webhook_secret` — for verifying inbound webhook authenticity.
- `peach_environment` — `test` or `production`.

These live in `tenant_secrets`, encrypted at rest. Admin enters them via the tenant settings UI; backend validates by issuing a test API call before saving.

## Top-up flow (Hosted Checkout)
1. Player picks a top-up amount. Per the [client blueprint](./client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md) A.3, Crusaders enforces:
   - **Multiples of `tenant_settings.topup_block_zar`** (default R100). UI validates client-side, API re-validates server-side.
   - **Maximum of `tenant_settings.topup_max_zar_per_member`** (default R1000) per top-up for non-admin users; admin manual adjustments are uncapped.
   - **Default presets** shown to the player: `[100, 200, 500, 1000]`.
   - The player sees both the ZAR amount and the credits they will receive (`zar * conversion_rate` where the rate is from `tenant_settings.credits_per_zar_<class>` based on the player's `Membership.MemberClass`).
2. Backend creates a `pending_topup` row: `tenant_id`, `user_id`, `amount`, `currency=ZAR`, `status=pending`, `idempotency_key=<uuid>`.
3. Backend calls PeachPayments to register a checkout, passing:
   - `merchantTransactionId = <pending_topup.id>` (so the webhook can reconcile)
   - `customer.merchantCustomerId = <user.id>`
   - `customer.email`
   - amount, currency, description (`Crusaders Mainframe top-up — R{amount}`)
   - `notificationUrl` = our webhook endpoint
   - `shopperResultUrl` = our return URL (mobile app)
4. PeachPayments returns a `checkoutId`. Backend redirects the player to PeachPayments' hosted page with that ID.
5. Player enters card details on PeachPayments' page. We never see them.
6. PeachPayments redirects back to our `shopperResultUrl` and (independently) POSTs a webhook to `notificationUrl`.

## Webhook handling
- Verify the signature using `peach_webhook_secret`. Reject on mismatch.
- Look up the `pending_topup` by `merchantTransactionId`.
- On `success` result code:
  - Resolve the player's `Membership.MemberClass` to look up the conversion rate from `tenant_settings.credits_per_zar_<class>`.
  - Write a `top_up` ledger entry with `amount_credits = zar * rate`, `zar_paid = zar`, `conversion_rate = rate`, `external_reference = <peach_payment_id>`.
  - Mark `pending_topup.status = completed`.
  - Send confirmation email (showing both ZAR paid and credits received).
  - Fire `credit.topped_up` outbound webhook (carries both `zar_paid` and `credits` in the payload).
- On `failure` or `cancelled`:
  - Mark `pending_topup.status = failed` with the reason.
  - No ledger entry.
  - Send a "top-up unsuccessful" email with the failure reason (sanitized).
- Idempotency: if we receive the same `peach_payment_id` twice, we no-op (ledger entry is unique on `external_reference`).

## Refunds
The system distinguishes two refund types:
1. **Internal refund (no money movement):** a credit refund — admin issues a credit adjustment to a player's balance. No PeachPayments call. Used for waiving penalties, goodwill, etc.
2. **External refund (money returns to the card):** explicitly requested by an admin via a "Refund this top-up" button on a `top_up` ledger entry. Calls PeachPayments' refund API; on success, writes a `payment_reversal` (negative) ledger entry. Used rarely — disputes, accidental top-ups.

**Default behavior** when a player cancels a booking is internal-only: their credit balance increases. The card is *not* refunded automatically. Admins can opt to issue an external refund if requested.

## Disputes & chargebacks
- PeachPayments emits a `chargeback` webhook event when a card transaction is disputed.
- On receipt: write a `payment_reversal` (negative) ledger entry; flag the player's account for admin review; email the admin.
- If the chargeback drives the player's balance negative, that's allowed — we don't unbook past sessions automatically. Admin decides next steps.

## Compliance & PCI scope
Using Hosted Checkout keeps us out of PCI-DSS Level 1 scope — the player's card never touches our servers. Self-Assessment Questionnaire SAQ-A applies. Document this in the tenant onboarding wizard so admins know what they're signing up for.

## Testing
- **Sandbox:** every tenant starts in `peach_environment = test` until they tick a "go live" checkbox; admin must enter live credentials separately.
- **Test cards:** PeachPayments publishes test PANs for success / decline / 3DS challenge — wire these into integration tests.
- **Webhook replay:** the integration test suite must replay a captured webhook payload and assert the ledger entry, email send, and outbound webhook all fire correctly.

## Out of scope (v1)
- Recurring billing / subscriptions (no tenant-level monthly fee yet — pricing model TBD).
- Apple Pay / Google Pay (PeachPayments supports them; revisit post-pilot if mobile conversion is an issue).
- Other African processors (Paystack, Yoco, Ozow). Architecture allows them as additional `IPaymentProvider` implementations later.
