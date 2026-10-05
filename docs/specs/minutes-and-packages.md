# Minutes and packages (P13) — the contract

This document is the contract for P13, "minutes, not credits". Every backend and frontend lane builds against it in parallel, so it states what each lane needs and does not explain the design again. The plan's reasoning is in the P13 plan and in Dean's answers of 2026-10-01. The source was grepped at `main-work` 5a8c6864. **Where this document and the plan disagree, this document wins.** Each such point is listed in §12 with the reason.

**Wire conventions, unchanged from today:**
- Response bodies are `snake_case` anonymous objects. Request bodies bind `camelCase` (ASP.NET web defaults, case-insensitive).
- A few records serialize with their own `camelCase` names. They are listed in §3.3.
- Rand is a JSON number with at most two decimals. Minutes are a JSON integer.

---

## 1. The unit

### 1.1 What the unit is

| Quantity | C# type | Postgres | JSON | Where it lives |
|---|---|---|---|---|
| Minutes (the ledger unit) | `int` | `integer` | integer, never `50.0` | every balance, charge, refund, penalty, share, hold and transfer |
| Rand | `decimal` | `numeric(10,2)` | number, at most 2 dp | purchase rows (`pending_topups.AmountZar`, `ListPriceZar`), `ledger_entries.ZarPaid`, `minute_packages.PriceZar`, desk `zarReceived`, reports `*_zar` |
| Discount | `int` basis points | `integer` | integer 0–10 000 | `member_groups.PackageDiscountBps`, `pending_topups.DiscountBps` |

A booking costs exactly its length in minutes, `SliceMinutes × SliceCount`, and nothing else. There are no court prices, no group prices and no conversion rates. Nothing in the system holds a fraction of a minute.

### 1.2 Rounding: who keeps every remainder

There is one rule. **Round down to a whole minute, in favour of whoever pays.** Rand is rounded down to the cent, in favour of the buyer.

| Movement | Rule | Source site today | Who keeps the remainder |
|---|---|---|---|
| Booking charge | `SliceMinutes × SliceCount`, exact | `BookingService.PriceAsync` (line 314 `totalCost`) | n/a |
| Equal or ratio split | each partner `floor(price × weight ÷ totalWeight)`; the organiser takes `price − Σ partners` | `SplitCalculator.cs` 92 / 129 (already `Math.Floor`) | organiser |
| Amount split | every `amount` must be a whole number ≥ 0, else `split_amount_invalid`; Σ ≤ price, else `split_exceeds_price` | `SplitCalculator.cs` 108 | organiser |
| Partner share after a no-show | `floor(owed × shareMinutes ÷ price)` | `ShareRules.cs` 65 (`MidpointRounding.ToZero` today) | organiser (partners never sum above `Owed`) |
| Late-cancel penalty | `floor(chargedMinutes × penalty_pct ÷ 100)` (`penalty_pct` stays `decimal`) | `BookingService.cs` 1183 | member |
| No-show penalty | same formula | `Webhooks/NoShowWorker.cs` 96 | member |
| Walk-up purchase | the granted minutes, `floor(endsAt − now)`, already whole | `BookingService.cs` 379–401 | member (the part-minute) |
| Cancelled court lit offline | `min(floor(lit duration in minutes), sold, relay cap, charged − retained penalty)` | `PriceLitTimeAsync` 2017–2029 | member. See §12.6 |
| Group discount on a package | `price_zar = floor_cent(list × (10 000 − bps) ÷ 10 000)` | new | member (a fraction of a cent) |
| Saving shown on a package | §4.3, rounded down to the cent and to the whole percent | new | n/a (display only) |

A discount never changes minutes. A "5 h" package is exactly 300 minutes for everybody.

### 1.3 Money invariants: tests must keep these green

1. A balance is `Σ ledger_entries.AmountMinutes`. No balance is ever stored.
2. Each `ShareTransfer` pair (`share:{pid}:{seq}:out|in`) nets to exactly 0, per booking and club-wide.
3. For each booking, `AmountChargedMinutes = refunded + penalty + kept`, exactly.
4. Split shares add up to the price exactly: `Σ partners + organiser = price`.
5. The PayFast callback is idempotent on `ExternalReference` (`topup:{tenant:N}:{pf_payment_id}`), and share references stay unique.
6. A pay-for nonce stays pinned to its quote. `price_changed` fires when the echoed `amount_label` differs.
7. `LedgerEntryTypeCoverageTests` passes with the type numbers and report buckets unchanged.
8. A callback credits the **locked** minutes on the `pending_topups` row, never the live package.
9. The unit guard (new) fails when reflection finds any property named `*Minutes` typed `decimal` or `decimal?`, or any property named `*Zar` typed `int`. It covers the `Crusaders.Mainframe.Api` assembly.
10. The source scan (new) is a shrinking list. It fails on any `credit`/`Credit` in `src/backend/Crusaders.Mainframe.Api` (Migrations excluded) or `src/frontend/src` outside the allow-list in §2.5.

### 1.4 Mutation checks: each must turn at least one test red

| Mutant | Must be caught by |
|---|---|
| Any rounding-down site in §1.2 changed to round-to-nearest or round-up | `SplitCalculatorTests`, `ShareRulesTests`, `NoShowWorkerTests`, cancellation tests |
| "Lowest discount wins" changed to "highest wins" | `MemberTariffsTests` |
| The callback reads the live package (minutes or price) instead of the locked row | `TopUpFlowTests` (purchase lock) |
| The saving computed against the largest package, or against a package from another shelf | saving pure-function tests |
| The organiser-remainder line dropped | `SplitCalculatorTests`, `PlayersPropertyHttpTests` (default 150 seeds) |
| The discount applied to minutes instead of rand | shelf tests |
| The migration refusal removed | migration refusal test |

---

## 2. Ledger fields and database schema after the migration

### 2.1 Renamed and retyped entity fields and columns

The column name is the property name (EF default). Every money column below becomes `integer NOT NULL`, unless marked otherwise.

| Entity · table | Old property / column | Old type | New property / column | New type |
|---|---|---|---|---|
| `LedgerEntry` · `ledger_entries` | `AmountCredits` | `numeric(10,2)` | `AmountMinutes` | `integer` |
| `Booking` · `bookings` | `AmountChargedCredits` | `numeric(10,2)` | `AmountChargedMinutes` | `integer` |
| `BookingParticipant` · `booking_participants` | `ShareCredits` | `numeric(10,2)` | `ShareMinutes` | `integer` |
| `BookingParticipant` · `booking_participants` | `ConsentedCredits` | `numeric(10,2)` | `ConsentedMinutes` | `integer` |
| `DevicePayFor` · `device_pay_fors` | `AmountCredits` | `numeric(10,2)` | `AmountMinutes` | `integer` |
| `DevicePayFor` · `device_pay_fors` | `BalanceAfterCredits` | `numeric(10,2)` | `BalanceAfterMinutes` | `integer` |
| `DevicePayFor` · `device_pay_fors` | `AmountLabel` | `varchar(16)` | unchanged | now always 1–4 digits |
| `LedgerPosting` (record) | `decimal AmountCredits` | | `int AmountMinutes` | |

The check constraints in `MainframeDbContext.Players.cs` are rewritten to name the new columns. Their names are unchanged:
- `ck_booking_participants_money`: `"ShareMinutes" >= 0 AND "ConsentedMinutes" >= 0 AND "ShareWeight" >= 0`.
- `ck_booking_participants_guest`: `… AND "ShareMinutes" = 0`.

The ledger type names and their stored numbers stay as they are, from `TopUp = 0` to `ShareTransfer = 9`. So does `ck_ledger_entries_type_range`.

The C# return types become `int` throughout the money path:
- `LedgerService.GetBalanceAsync`, `GetSpendableAsync` and `GetCoverageAsync`.
- `HeldCredits` → `HeldMinutes`, `HeldPart(int Minutes, DateTimeOffset Until)`.
- `SplitShare(int Seat, int ShareMinutes, int Weight)`.
- `BookingResult.InsufficientBalance(int CurrentMinutes, int RequiredMinutes)`.
- `CancellationResult.Ok(int RefundedMinutes, int PenaltyMinutes)`.
- The bulk records in §3.3, and every `*Credits` record member, become `*Minutes` and `int`.

### 2.2 Dropped

| What | Where |
|---|---|
| `Court.SlicePriceCredits` · `courts.SlicePriceCredits` | `Domain/Court.cs` 23, DbContext 195 |
| `MemberGroup.PricingMode`, `PriceMultiplierBps`, `FlatSlicePriceCredits`, `CreditsPerZar` and their columns; enum `GroupPricingMode` | `Domain/MemberGroup.cs` 78–101, DbContext 323–330 |
| Check constraints `ck_member_groups_credits_per_zar` and `ck_member_groups_pricing` | DbContext 338–348 |
| `LedgerEntry.ConversionRate` · `ledger_entries.ConversionRate` | `LedgerEntry.cs` 171, DbContext 709 |
| `PendingTopup.ConversionRate` · `pending_topups.ConversionRate` | `PendingTopup.cs` 41, DbContext 299 |
| `LedgerPosting.ConversionRate` | `LedgerService.cs` 413 |
| `MemberGroupRules.PricingMode / PriceMultiplierBps / FlatSlicePriceCredits`, `GroupRules.PriceFor` (both overloads), `RuleSlot.CourtSlicePriceCredits`, `RuleVerdict.Allowed(decimal)` → `RuleVerdict.Allowed()` | `GroupRules.cs`, `BookingRules.cs` 47–53 |
| `MoneySettings.MinSlicePriceCredits / MaxSlicePriceCredits / SlicePriceCredits / IsWholeCents`. `IsWholeCents` moves wherever rand validation needs it. | `MoneySettings.cs` |
| `TenantSettingsView.DefaultSlicePriceCredits`, `CreditsPerZarRegular`, `TopupBlockZar`, `TopupMaxZarPerMember` | `TenantSettingsAccessor.cs` 28–43, 324–332 |
| `ScheduleCourt.SlicePriceCredits`, `ScheduleRules.SlicePriceCredits`, `ScheduleRules.SlicePricesByCourt`, record `CourtSlicePrice` | `ScheduleService.cs` 330–366 |
| `CourtPrices` (group price preview) | `MemberGroupEndpoints.cs` |
| `TopUpEndpoints.Convert`, `RefuseStaleQuote`, `RefuseCumulativeAsync`, `RefuseAmount`, `PaidZarAsync`, `Presets`, `RateGroupWire`, `LegacyClassOfGroupAsync`, and the `PayerLock` around a purchase insert (it existed only for the cap) | `TopUpEndpoints.cs` |
| `DevicePayForEndpoint.WireCredits` | `DevicePayForEndpoint.cs` 563 |
| `Bootstrap:SlicePriceCredits` (config, its check and its compose and `.env.example` lines) | `ProductionBootstrap.cs` 141–154, 348 · `docker-compose.yml` 88 · `docker-compose.prod.yml` 87 · `.env.example` 61 |
| `MemberGroupSeeder.DefaultLeagueCreditsPerZar` | `MemberGroupSeeder.cs` 50 |

### 2.3 Added

**`MinutePackage` · `minute_packages`** (new, `ITenantScoped`, query filter `TenantId == _tenant.TenantId`):

| Column | Type | Rule |
|---|---|---|
| `Id` | `uuid` PK | |
| `TenantId` | `uuid NOT NULL` | |
| `GroupId` | `uuid NULL`, FK → `member_groups.Id` `ON DELETE RESTRICT` | null = a club package (every member). A value = only that group's active members. **Fixed once the package is created.** |
| `Name` | `varchar(64) NOT NULL` | trimmed, 1–64 characters |
| `Minutes` | `integer NOT NULL` | `ck_minute_packages_minutes`: `"Minutes" BETWEEN 1 AND 60000` |
| `PriceZar` | `numeric(10,2) NOT NULL` | `ck_minute_packages_price`: `"PriceZar" > 0 AND "PriceZar" <= 100000` |
| `SortOrder` | `integer NOT NULL DEFAULT 0` | ≥ 0 |
| `Status` | `integer NOT NULL DEFAULT 0` | `0` Active, `1` Archived. `ck_minute_packages_status`: `"Status" IN (0, 1)`. **A package is never deleted**, because purchase rows name it. |
| `CreatedAt`, `UpdatedAt` | `timestamptz NOT NULL` | |
| `CreatedByUserId` | `uuid NOT NULL` | |

Indexes:
- `(TenantId, Status)`.
- `(TenantId, GroupId)`.
- A unique, filtered index on `(TenantId, GroupId, Name)` with `WHERE "Status" = 0` and `NULLS NOT DISTINCT`.

**`member_groups.PackageDiscountBps`** is `integer NULL`. `ck_member_groups_package_discount` checks `"PackageDiscountBps" IS NULL OR "PackageDiscountBps" BETWEEN 0 AND 10000`. Null means the group has no say.

**`pending_topups`.** The class and table keep their names. The purchase lock is these new columns, all `NOT NULL` (the table is empty when they are added, §2.4):

| Column | Type | Meaning |
|---|---|---|
| `PackageId` | `uuid` (no FK) | the package bought |
| `PackageName` | `varchar(64)` | a copy, frozen at checkout |
| `Minutes` | `integer` | the minutes the callback credits. `ck_pending_topups_minutes`: `> 0` |
| `ListPriceZar` | `numeric(10,2)` | the package price before any discount |
| `DiscountBps` | `integer DEFAULT 0` | the discount applied, `0` when none. `ck_pending_topups_discount`: `BETWEEN 0 AND 10000` |
| `GroupId` (existing) | `uuid NULL` | **now means** the group whose discount was locked. Null when there was no discount. |
| `AmountZar` (existing) | `numeric(10,2)` | what PayFast is asked for: the price after discount |

`LedgerEntryTypes`, `TopUpStatus`, `IdempotencyKey`, `GatewayCheckoutId`, `ExternalReference`, `FailureReason`, `CompletedAt`, the unique `(TenantId, ExternalReference)` index and `PendingLifetime` (60 min) all stay unchanged.

### 2.4 The migration `MinutesReplaceCredits`

There is **one forward migration**, owned by B0. Nothing is squashed: `GroupsReplaceClassMigrationTests` targets `20260923161528`, and the Designer-snapshot trap in `memory/gotchas-build.md` applies.

**The refusal rule (pre-launch).** `Up` first runs one `DO $$ … $$` block. It raises `'MinutesReplaceCredits: pre-launch reset required — money history exists (<table>)'` if any of the following holds:
- `ledger_entries` has any row;
- `pending_topups` has any row;
- `device_pay_fors` has any row;
- any `bookings` row has `"AmountChargedCredits" <> 0`;
- any `booking_participants` row has `"ShareCredits" <> 0 OR "ConsentedCredits" <> 0`.

Converting credits to minutes has no meaning, and silently deleting money rows is worse than refusing. The reset is `make down-reset` for development. `docs/go-live-checklist.md` gains one reset step for any club database (B0 writes it).

**On an empty ledger, `Up`:**
1. Renames and retypes the §2.1 columns with `USING round("X")::integer`. Every value is 0 by the refusal rule.
2. Rewrites the two `booking_participants` checks.
3. Drops the §2.2 columns and checks.
4. Adds `minute_packages` with its indexes and checks.
5. Adds `member_groups.PackageDiscountBps` and its check.
6. Adds the `pending_topups` lock columns and their checks.

**`Down`** applies the same refusal. On an empty ledger it restores the old columns with their old types and defaults (`courts.SlicePriceCredits` 8, `PricingMode` 0, `PriceMultiplierBps` 10000), then drops `minute_packages` and the new columns.

No later lane adds schema. A lane that needs a column asks the integrator.

### 2.5 The "credit" scan allow-list

These tokens may still contain "credit" after phase 2, each for a stated reason. The scan in §1.3.10 allows only these.

| Token | Why it stays |
|---|---|
| `/api/v1/credit/topup/callback` | PayFast's ITN `notify_url`, an external contract. A checkout in flight at deploy time calls it. |
| change-record actions `credit.adjusted` and `credit.topped_up`; area `credit` | Stored codes in the append-only `admin_change_log` (trigger `20260921203215`). Their words change (§6). |
| audit action `credit.adjusted` (`AdminCreditReasons.AuditAction`) | Stored in `audit_log.Action`. |
| change-record JSON keys on old rows (`balance_credits`, `amount_credits`, `credits_per_zar`, `flat_slice_price_credits`, `slice_price_credits`, `pricing_mode`, `multiplier_bps`) | Frontend labels only, so old immutable rows still read in words (`changeRecordCopy.ts`) |
| retired settings keys `slice_price_credits`, `credits_per_zar_regular`, `credits_per_zar_league` | Bound and ignored on the settings PUT (§3.9). They may remain in stored `tenant_settings` documents. |
| `EF Migrations/**` | History |
| `AdminCreditReasons` (class name) | A class name only, not a unit on the wire. B2 may rename it. The scan matches `credit` as a substring, so "credential" is never hit. |

---

## 3. API

### 3.1 Routes that move

| Old | New | Owner |
|---|---|---|
| `GET /api/v1/credit/topup/options` | **removed**. Replaced by `GET /api/v1/minutes/packages` (§3.4) | B2 |
| `POST /api/v1/credit/topup` `{amountZar, quotedConversionRate}` | `POST /api/v1/minutes/purchase` `{packageId, quotedPriceZar}` | B2 |
| `GET /api/v1/credit/topup/{topupId}` | `GET /api/v1/minutes/purchase/{purchaseId}` | B2 |
| `POST /api/v1/credit/topup/{topupId}/cancel` | `POST /api/v1/minutes/purchase/{purchaseId}/cancel` (stays: the cancel return) | B2 |
| `POST /api/v1/credit/topup/callback?tenant=` | **unchanged** | B2 |
| `POST /api/v1/admin/credit/{userId}/adjust` | `POST /api/v1/admin/minutes/{userId}/adjust` (goodwill etc., §3.7) | B2 |
| — | `POST /api/v1/admin/minutes/{userId}/sell` (sell a package at the desk, §3.7) | B2 |
| — | `GET /api/v1/admin/minutes/{userId}/packages` (the member's shelf, for the desk) | B2 |
| — | `GET/POST /api/v1/admin/packages`, `PUT /api/v1/admin/packages/{id}`, `POST /api/v1/admin/packages/{id}/archive` (§3.5) | B2 |
| PayFast `return_url` `{base}/wallet/topup/{id}` | `{base}/wallet/buy/{purchaseId}` | B2 (server) / F2 (page) |
| PayFast `cancel_url` `{base}/wallet/topup/{id}?cancelled=1` | `{base}/wallet/buy/{purchaseId}?cancelled=1` | B2 / F2 |
| SPA `/wallet/topup`, `/wallet/topup/:topupId` | `/wallet/buy`, `/wallet/buy/:purchaseId`. **The old paths stay as `<Navigate replace>` redirects**, because a PayFast return in flight at deploy time lands on the old URL. | integrator (`App.tsx`) / F2 |
| — | SPA `/admin/packages` | integrator (`App.tsx`) / F3 |

Every other route keeps its path. Only its keys change (§3.2, §3.3). The frontend `MONEY_PATHS` (`lib/api.ts` 476) becomes `["/api/v1/bookings", "/api/v1/invites/", "/api/v1/admin/bookings", "/api/v1/admin/minutes/", "/api/v1/minutes/purchase"]`.

### 3.2 Every `snake_case` `*credits*` key: old → new

**The rule.** Replace `credits` with `minutes` and type the value as an integer. The exceptions are marked **removed** or **special**. The table lists every snake identifier in `src/backend/Crusaders.Mainframe.Api`, Migrations excluded: 79 identifiers in 49 files. Some are request keys, some response keys, some webhook/event `data` keys, some audit/change-record JSON keys and some error codes. The file column names where each appears.

| Old key | New key | Appears in |
|---|---|---|
| `adjustments_credits` | `adjustments_minutes` | AdminMemberEndpoints (spend), ReportingEndpoints |
| `amount_charged_credits` | `amount_charged_minutes` | LightsCueWorker (event data) |
| `amount_credits` | `amount_minutes` | AdminScheduleEndpoints, CourtActivationResponse, ReportingEndpoints, AdminCancelRecord, AdminBulkBookingEndpoints, DeviceEventEndpoints, DevicePayForEndpoint, WalletEndpoints, MemberBulkBookingEndpoints, AdminMemberTraceEndpoints, LedgerService, BookingService, CourtActivationService, ControlBoardReader |
| `balance_after_credits` | `balance_after_minutes` | BookingEndpoints, DeviceEventEndpoints, DevicePayForEndpoint, MemberBulkBookingEndpoints, WalletEndpoints, AdminBulkBookingEndpoints, AdminMemberTraceEndpoints, BookingService, PlayersQuery, PlayersAdminService |
| `balance_before_credits` | `balance_before_minutes` | MemberBulkBookingEndpoints, WalletEndpoints, AdminBulkBookingEndpoints, BookingService, PlayersAdminService |
| `balance_credits` | `balance_minutes` | AdminMemberEndpoints, ReportingEndpoints, AdminMemberDetailEndpoints, WalletEndpoints, AdminBulkBookingEndpoints, BookingEndpoints, LedgerService, BookingService, PlayersService.Member, PlayersQuery |
| `booking_charges_credits` | `booking_charges_minutes` | ReportingEndpoints |
| `charged_credits` | `charged_minutes` | AdminMemberDetailEndpoints, BookingService |
| `charged_now_credits` | `charged_now_minutes` | MemberBulkBookingEndpoints |
| `collected_credits` | `collected_minutes` | PlayersAdminService |
| `consented_credits` | `consented_minutes` | PlayersService.Member, PlayersQuery, PlayersAdminService |
| `covered_credits` | `covered_minutes` | PlayersAdminService |
| `current_credits` | `current_minutes` | CourtActivationResponse, DeviceEventEndpoints, BookingEndpoints, PlayersService.Member |
| `delta_credits` | `delta_minutes` | WalletEndpoints, LedgerService |
| `gross_topups_credits` | `gross_topups_minutes` | ReportingEndpoints |
| `held_credits` | `held_minutes` | BookingEndpoints, AdminMemberDetailEndpoints, AdminBulkBookingEndpoints, MeProfileEndpoints, WalletEndpoints, LedgerService, PlayersService.Member, PlayersQuery |
| `manual_compensation_credits` | `manual_compensation_minutes` | BookingService |
| `max_credits` | `max_minutes` | WalletEndpoints (`amount_out_of_range`) |
| `measured_credits` | `measured_minutes` | BookingService |
| `my_owing_credits` | `my_owing_minutes` | UpcomingGames |
| `my_paid_credits` | `my_paid_minutes` | UpcomingGames |
| `my_share_credits` | `my_share_minutes` | UpcomingGames |
| `net_court_spend_credits` | `net_court_spend_minutes` | ReportingEndpoints |
| `net_credits` | `net_minutes` | BookingEndpoints, AdminMemberEndpoints, ReportingEndpoints, AdminBulkBookingEndpoints, BookingService (comments in MainframeDbContext, LedgerEntry) |
| `net_movement_credits` | `net_movement_minutes` | ReportingEndpoints |
| `organiser_net_credits` | `organiser_net_minutes` | PlayersQuery |
| `organiser_owed_credits` | `organiser_owed_minutes` | PlayersQuery |
| `original_price_credits` | `original_price_minutes` | BookingService |
| `owed_back_credits` | `owed_back_minutes` | BookingEndpoints, MeProfileEndpoints, AdminMemberDetailEndpoints, WalletEndpoints, AdminBulkBookingEndpoints, LedgerService, PlayersService.Member, PlayersQuery |
| `paid_credits` | `paid_minutes` | PlayersService.Member, PlayersQuery, PlayersQuery.ShareSummaries |
| `paid_in_app_credits` | `paid_in_app_minutes` | PlayersAdminService |
| `penalties_credits` | `penalties_minutes` | AdminMemberEndpoints, ReportingEndpoints |
| `penalty_credits` | `penalty_minutes` | BookingEndpoints, AdminBulkBookingEndpoints, NoShowWorker, BookingService, PlayersQuery |
| `penalty_reversed_credits` | `penalty_reversed_minutes` | BookingService |
| `penalty_settled_credits` | `penalty_settled_minutes` | BookingService |
| `price_credits` | `price_minutes` | PlayersEndpoints, BookingEndpoints, AdminBulkBookingEndpoints, PlayersQuery |
| `recharged_credits` | `recharged_minutes` | BookingService |
| `refund_credits` | `refund_minutes` | AdminBulkBookingEndpoints, NoShowWorker, BookingService |
| `refund_reversed_credits` | `refund_reversed_minutes` | BookingService |
| `refund_settled_credits` | `refund_settled_minutes` | BookingService |
| `refunded_credits` | `refunded_minutes` | BookingEndpoints, PlayersQuery |
| `refunds_credits` | `refunds_minutes` | AdminMemberEndpoints, ReportingEndpoints |
| `required_credits` | `required_minutes` | CourtActivationResponse, DeviceEventEndpoints, BookingEndpoints, PlayersService.Member |
| `return_credits` | `return_minutes` | PlayersAdminService |
| `returned_credits` | `returned_minutes` | BookingService, PlayersQuery |
| `reversals_credits` | `reversals_minutes` | ReportingEndpoints |
| `share_credits` | `share_minutes` | PlayersEndpoints, InviteLookups, PlayersService, PlayersService.Member, PlayersQuery, PlayersAdminService |
| `share_transfers_credits` | `share_transfers_minutes` | ReportingEndpoints |
| `shares_received_credits` | `shares_received_minutes` | PlayersQuery |
| `short_by_credits` | `short_by_minutes` | PlayersQuery |
| `spendable_credits` | `spendable_minutes` | BookingEndpoints, WalletEndpoints, AdminBulkBookingEndpoints, LedgerService, BookingService, PlayersService.Member, PlayersQuery |
| `spent_credits` | `spent_minutes` | ReportingEndpoints, AdminMemberEndpoints |
| `target_credits` | `target_minutes` | PlayersQuery |
| `to_pay_credits` | `to_pay_minutes` | PlayersQuery |
| `top_ups_credits` | `top_ups_minutes` | ReportingEndpoints, AdminMemberEndpoints |
| `total_charged_credits` | `total_charged_minutes` | MemberBulkBookingEndpoints, AdminBulkBookingEndpoints |
| `total_credits` | `total_minutes` | AdminBulkBookingEndpoints (bulk quote) |
| `total_penalty_credits` | `total_penalty_minutes` | AdminBulkBookingEndpoints |
| `total_refunded_credits` | `total_refunded_minutes` | AdminBulkBookingEndpoints |
| `unpaid_credits` | `unpaid_minutes` | PlayersQuery |
| `would_refund_credits` | `would_refund_minutes` | AdminScheduleEndpoints, BookingScheduleService |
| **special** `quoted_credits` | utilisation: **`sold_minutes`**. Top-up: **removed** | ReportingEndpoints, TopUpEndpoints |
| **special** `revenue_credits` | **`kept_minutes`** (utilisation) | ReportingEndpoints |
| **special** `credits_spent` | **`minutes_spent`** | AdminMemberTraceEndpoints |
| **special** `credits_received` | **`minutes_received`** | AdminMemberTraceEndpoints |
| **removed** `slice_price_credits` | settings GET, court list/create/update, group preview, change-record snapshot, bootstrap. The settings PUT binds it and ignores it (§3.9). | MemberGroupEndpoints, AdminConfigEndpoints, AdminCourtEndpoints, ProductionBootstrap, Seeder, Tenant, TenantSettingsAccessor, MoneySettings |
| **removed** `slice_price_range_credits` | group preview | MemberGroupEndpoints |
| **removed** `flat_slice_price_credits` | group wire, group validation, change-record snapshot | MemberGroupChanges, MemberGroupValidation, MemberGroupEndpoints |
| **removed** `effective_example_credits`, `effective_range_credits` | group wire `pricing` block | MemberGroupEndpoints |
| **removed** `credits_per_zar` | group wire, group request, change-record snapshot, member spend. Replaced by `package_discount_bps`. | AdminMemberEndpoints, MemberGroupChanges, AdminConfigEndpoints, MemberGroupEndpoints |
| **removed** `top_up_credits_per_zar` | tariff wire. Replaced by `package_discount_bps` and `discount_group_id` (§3.8). | MeProfileEndpoints, MemberGroupAudit, AdminMemberGroupsEndpoint, MemberGroupEndpoints, AdminMemberDetailEndpoints |
| **removed** `credits_per_zar_regular`, `credits_per_zar_league` | settings. The PUT binds them and ignores them (§3.9). | TopUpEndpoints, AdminConfigEndpoints, MemberGroupEndpoints, Seeder, MemberGroup, CurrencySymbol, TenantSettingsAccessor, MemberTariffs, MemberGroupSeeder |
| **removed** `credits_per_zar_` | doc comments only | TopUpEndpoints, PendingTopup, CurrencySymbol |
| **removed** error codes `credits_per_zar_regular_out_of_range`, `credits_per_zar_league_moved_to_groups`, `slice_price_credits_out_of_range`, `slice_price_credits_not_whole_cents`, `group_credits_per_zar_invalid`, `price_negative` | | AdminConfigEndpoints, MemberGroupValidation, AdminCourtEndpoints |
| **removed** DB check `ck_member_groups_credits_per_zar` | §2.2 | MainframeDbContext |

**Bare `credits` keys** (no underscore) become `minutes`, integer:

| Where | Old | New |
|---|---|---|
| `held_parts[]` (wallet, stream, member detail, players reads; `ShareHolds.WireParts`) | `{credits, until}` | `{minutes, until}` |
| `partner_refunds[]` (`PartnerRefund`, cancel answer, cancel quote, bulk cancel) | `{user_id, name, credits}` | `{user_id, name, minutes}` |
| PayFast callback 200 answer | `{ok, credits, conversion_rate}` | `{ok, minutes, package_id}` |
| `credit.topped_up` event data | `credits` | `minutes` (§5) |
| group `effective_by_court[]` / preview `slice_prices_by_court[]` | `{court_id, court_name, credits}` | **removed** |
| admin ledger `totals` (`AdminLedgerEndpoints.TotalsAsync`) | `{count, credits, debits, net}` | `{count, in_minutes, out_minutes, net_minutes}`. "credits" was the accounting word for money in; it goes too (§12.7). |

### 3.3 `camelCase` keys on the wire

These records serialize or bind with their own `camelCase` names. Rename them the same way.

| Record · direction | Old key | New key |
|---|---|---|
| `LedgerRowDto` (wallet `entries[]`, admin ledger `items[]`) · response | `amountCredits`, `signedAmountCredits` | `amountMinutes`, `signedAmountMinutes` (int) |
| `CancellationQuote` (`GET /bookings/{id}/cancellation-quote`) · response | `amountChargedCredits`, `refundCredits`, `penaltyCredits` (and snake `net_credits`, `partner_refunds`) | `amountChargedMinutes`, `refundMinutes`, `penaltyMinutes`, `net_minutes`, `partner_refunds[{user_id,name,minutes}]`. `penaltyPct` stays `decimal`. |
| `ScheduleSlot` (`GET /api/v1/schedule`) · response | `amountChargedCredits` | `amountChargedMinutes` (int, null) |
| `ScheduleCourt` · response | `slicePriceCredits` | **removed** |
| `ScheduleRules` · response | `slicePriceCredits`, `slicePricesByCourt` | **removed** |
| `AdjustRequest` · request | `amountCredits` | `amountMinutes` (int) |
| `AcceptRequest` (`…/players/{pid}/accept`, `/invites/{token}/accept`) · request | `expectedShareCredits` | `expectedShareMinutes` (int) |
| `SplitPreviewRequest` (`POST /players/split-preview`) · request | `priceCredits` | `priceMinutes` (int) |
| `PlayerSpec.amount` · request | decimal with 2 dp | **same key**, now a whole number of minutes |
| `CreateCourtRequest` / `UpdateCourtRequest` · request | `slicePriceCredits` | **removed**. An old client's value is ignored. |
| `GroupPricingRequest` (`pricing` on the group POST and PATCH) · request | `mode`, `multiplierBps`, `flatSlicePriceCredits` | **removed**. Unknown members are ignored by System.Text.Json, so an old console is not refused. |
| `MemberGroupRequest` · request | `creditsPerZar` / `credits_per_zar` | **removed**. Replaced by `packageDiscountBps` / `package_discount_bps` (§3.8). |
| `UpdateSettingsRequest` · request | `slicePriceCredits`, `creditsPerZarRegular`, `creditsPerZarLeague`, `topupBlockZar`, `topupMaxZarPerMember` | **bound and ignored** (§3.9) |
| `TopUpRequest` · request | `amountZar`, `quotedConversionRate` | **removed with the route** |

### 3.4 Member purchase routes

All of these require auth, and the member is `ctx.User`.

**`GET /api/v1/minutes/packages`**, the member's shelf (the shelf rule is in §4.2):

```json
{
  "discount": { "bps": 1000, "group": { "id": "uuid", "name": "League" } },
  "packages": [
    {
      "id": "uuid",
      "name": "5 hours",
      "minutes": 300,
      "list_price_zar": 550.00,
      "discount_bps": 1000,
      "price_zar": 495.00,
      "saving_zar": 45.00,
      "saving_pct": 8,
      "source": "club",
      "group": null
    }
  ],
  "open_checkouts": [
    { "id": "uuid", "package_name": "5 hours", "minutes": 300, "amount_zar": 495.00,
      "created_at": "…Z", "expires_at": "…Z" }
  ]
}
```

- `discount` is `null` when no active group of the member sets one. When it is set, it applies to `source: "club"` items only.
- A `source: "group"` item carries `group: {id, name}` and `discount_bps: 0`.
- `saving_zar` and `saving_pct` are `null` unless `saving_zar > 0`. `saving_pct` is also `null` when it rounds down to 0.
- `open_checkouts` lists the member's `Pending` rows created within `PendingLifetime`, newest first. `expires_at` is `created_at + 60 min`. It replaces `counts_until`.

**`POST /api/v1/minutes/purchase`**. Body: `{ "packageId": "uuid", "quotedPriceZar": 495.00 }`.

| Status | Body | When |
|---|---|---|
| 200 | `{ purchase_id, checkout_id, redirect_url, form_fields: [{name, value}], package: {id, name, minutes}, amount_zar }` | registered with PayFast. `amount_zar` is the locked price. |
| 400 | `{ error: "package_id_required" }` · `{ error: "quoted_price_required" }` | missing field |
| 409 | `{ error: "package_unavailable" }` | not on this member's shelf now: archived, another club's, a group the member is not in, or an archived group |
| 409 | `{ error: "package_price_changed", package: <shelf item as now> }` | `quotedPriceZar ≠` the live shelf `price_zar`, compared exactly. This replaces `topup_rate_changed`. |
| 409 | `{ error: "package_price_zero" }` | the live price after discount is below R0.01 (a 100% discount). The desk can sell it (§3.7). |
| 503 | `{ error: "payments_not_configured" }` | unchanged |
| 502 | `{ error: "provider_register_failed", reason }` | unchanged. The row goes `Failed`. `TopUpAlerts` stages `topup.failed`. |

There is no cap and no block check, and admins are treated like anyone else on this route.

The server builds the purchase lock row (§2.3) from the shelf item **before** it calls PayFast.

PayFast `item_name` is `"{club name} - {package name} ({compact minutes})"`, for example `Crusaders - 5 hours (5 h)`:
- ASCII hyphen only, so the PHP-`urlencode` signature parity is untouched;
- truncated to 100 characters;
- `amount` is `AmountZar` in the invariant culture.

**`GET /api/v1/minutes/purchase/{purchaseId}`** and **`POST …/{purchaseId}/cancel`** (the own row only, else 404). Both answer:

```json
{ "id": "uuid", "status": "Pending|Completed|Failed|Cancelled", "package_id": "uuid",
  "package_name": "5 hours", "minutes": 300, "list_price_zar": 550.00, "discount_bps": 1000,
  "amount_zar": 495.00, "failure_code": null, "created_at": "…Z", "expires_at": "…Z" }
```

The cancel return keeps its M4-1 semantics: a conditional `Pending → Cancelled/cancelled_at_return`, idempotent, no mail, reopenable by a late COMPLETE. `TopUpExpiryWorker` is unchanged and still writes `expired`.

**The PayFast callback** (route unchanged) keeps everything it does today:
- the signature check;
- `merchant_txn_missing`, `payment_id_missing`, `amount_mismatch` (against `AmountZar`), `already_settled`, `payment_id_conflict`;
- the idempotency on `ExternalReference`;
- the late COMPLETE reopening a `cancelled_at_return` or `expired` row.

On COMPLETE it posts **one** `TopUp` row:

```
AmountMinutes = pending.Minutes                      // the LOCKED minutes, never the live package
ZarPaid       = pending.AmountZar
Reason        = "PayFast purchase: {PackageName} ({MoneyFormat.Minutes(Minutes)}) for {Zar(AmountZar)}"
ExternalReference = topup:{tenant:N}:{pf_payment_id}
```

The callback then sends the purchase confirmation (§6), emits `minutes.purchased` (§5) and answers `{ ok: true, minutes, package_id }`.

### 3.5 Admin package routes

These require the `admin` role and the `writes` rate limit. Request bodies are camelCase.

| Route | Body | Answer |
|---|---|---|
| `GET /api/v1/admin/packages?status=active\|archived\|all` (default `active`) | — | `{ packages: [AdminPackage] }`, ordered by `group` (club first), then `sort_order`, `minutes`, `name` |
| `POST /api/v1/admin/packages` | `{ name, minutes, priceZar, groupId?, sortOrder? }` | 201 `AdminPackage` |
| `PUT /api/v1/admin/packages/{id}` | `{ name, minutes, priceZar, sortOrder, groupId?, reason? }` (full replace; `groupId` may be omitted or must equal the stored value) | 200 `AdminPackage` |
| `POST /api/v1/admin/packages/{id}/archive` | `{ reason? }` | 200 `AdminPackage`. Idempotent: archiving an archived package answers 200 and writes no second change row. |

`AdminPackage` is:

```json
{ "id", "name", "minutes", "price_zar", "group": {"id","name"}|null, "sort_order", "status": "active|archived", "created_at", "updated_at" }
```

| Error | Status | Detail |
|---|---|---|
| `package_name_invalid` | 400 | `{min: 1, max: 64}` after trim |
| `package_minutes_invalid` | 400 | `{min: 1, max: 60000}`. Must be an integer: a JSON `30.5` is refused, not truncated. |
| `package_price_invalid` | 400 | `{min_exclusive: 0, max: 100000, decimals: 2}` |
| `package_sort_order_invalid` | 400 | `{min: 0}` |
| `package_group_invalid` | 400 | `groupId` is not an active group of this club |
| `package_limit_reached` | 409 | `{max: 50}` active packages per club |
| `package_name_taken` | 409 | `{name}` already active on the same shelf (same `groupId`, null included) |
| `package_group_immutable` | 409 | the PUT names a different `groupId` |
| `package_archived` | 409 | a PUT on an archived package |
| — | 404 | an unknown id, **or another club's id** (cross-tenant test required) |

**Editing a package never changes an open checkout.** The checkout is locked on its `pending_topups` row.

When a group is archived, its packages leave every shelf. Their status is left alone and they come back if the group is reactivated.

**Change record.** Each write records in its own save:
- area `credit`;
- subject kind `AdminChangeSubjects.Package = "package"`;
- subject label = the package name;
- actions `package.created`, `package.updated` and `package.archived`.

Before and after carry `{name, minutes, price_zar, group, sort_order, status}`. `package.archived` is **not** in `ReasonRequired`. Each new action gets a `Headline` and a frontend catalogue entry, because round 4 requires every vocabulary action to have a writer.

### 3.6 The removed cap

Dean's answer 1 removes the cap entirely. This disappears:
- **Settings.** `topup_max_zar_per_member` and `topup_block_zar` go from the settings GET, the PUT validation (`topup_block_zar_out_of_range`, `topup_max_below_block`), `TenantSettingsView`, `ecoSettings.ts`, `settingsSchema.ts` and the onboarding and setup-checklist copy. **The PUT binds both and ignores them.**
- **Refusals.** `amount_exceeds_member_cap` (both forms), `amount_must_be_multiple_of_block` and `amount_must_be_positive`.
- **Keys.** `block_zar`, `min_zar`, `max_zar`, `already_zar`, `paid_zar`, `waiting_zar`, `remaining_zar`, `presets_zar`, `conversion_rate`, `rate_group`, `member_class` (from `/topup/options`) and `counts_until`.
- **Code.** `PaidZarAsync`, `RefuseCumulativeAsync`, `RefuseAmount`, `Presets`, the `PayerLock` on the purchase path, and the frontend `lib/topUpOpen.ts` "uses your limit" wording.
- **The admin exemption on this route.** There is nothing left to exempt.

**What stays:** listing open checkouts (`open_checkouts` on the shelf), the cancel return route, the one-hour expiry worker, reopening on a late COMPLETE, `topup_failure_cooldown_minutes` and the `topup.failed` admin notice (§5).

### 3.7 The desk: sell a package, and adjust minutes

**`GET /api/v1/admin/minutes/{userId}/packages`** gives the shelf from §3.4 **as that member sees it**, without `open_checkouts`. It answers 404 for an unknown or another club's member.

**`POST /api/v1/admin/minutes/{userId}/sell`.** This replaces the three top-up reason codes on `/adjust`.

```json
{ "packageId": "uuid", "reasonCode": "top_up_cash|top_up_eft|top_up_card_offline|package_free",
  "quotedPriceZar": 495.00, "zarReceived": 495.00, "reason": "Paid cash at the bar", "idempotencyKey": "…" }
```

- The package must be on the member's shelf now. If not, 409 `package_unavailable`.
- **`quotedPriceZar` (review round 9, J9-1)** is the price the desk was SHOWN. It must equal the member's live shelf `price_zar`, else 409 `package_price_changed` `{package, discount}` (the member purchase path's shape) and nothing is posted — the sheet names the new price and asks for a fresh confirm. A free give whose price is no longer 0 is the same 409.
- `zarReceived` is the rand taken; it defaults to `quotedPriceZar`, never to the write-time price. At least one of the two is required (400 `quoted_price_required`). When sent, it must be 0 to 1 000 000 in whole cents (B7: `zar_received_out_of_range`, `zar_received_not_whole_cents`). It may differ from the price.
- `reasonCode` outside the four codes: 400 `reason_code_invalid`, with `valid` listing the four. A blank `reason`: 400 `reason_required`.
- **`package_free` (review round 7, J7-10)** is valid ONLY when the member's shelf `price_zar` for that package is 0.00; on a priced package it is 400 `reason_code_invalid` with `valid` listing the three paid codes. With it, `zarReceived` is optional and, when sent, must be 0 (else 400 `zar_received_out_of_range`, `max: 0`); the row records `ZarPaid = 0`, the change record and audit carry `reason_code: package_free`, and the mail says the package was given at no charge (no "Amount received"). Revenue counts it as R0.00, as it already did. A R0.00 package may still be sold under a paid code — the desk may take money anyway. Since R14 one rule decides **given**: a desk top-up with no rand recorded (`ZarPaid` 0 or null), whatever the code — reports' `given_minutes`, the Night's "at no charge" line and the desk mail all use it.
- On success it posts one `AdminTopUp` row: `AmountMinutes = package.Minutes`, `ZarPaid = zarReceived`, `Reason = "{reason} — {package name}"`, and `ExternalReference = adjust:{tenant:N}:{key}` when a key was sent. Idempotency works as today (`idempotency_key_reused` on a different replay).
- It records change action `credit.topped_up` (code kept, §2.5) and audit action `credit.adjusted`. The audit details add `package_id`, `package_name` and `minutes`.
- It mails `EmailTemplates.PackageSoldAtDesk` (§6) — its no-charge form for `package_free`.
- It answers `{ entry_id, type: "AdminTopUp", reason_code, amount_minutes, zar_received, balance_before_minutes, balance_after_minutes, member: {user_id, email}, package: {id, name, minutes, price_zar} }`.

**`POST /api/v1/admin/minutes/{userId}/adjust`** handles goodwill and corrections.

```json
{ "amountMinutes": -45, "reasonCode": "goodwill|correction|refund_outside_system|other",
  "reason": "…", "relatedBookingId": "uuid?", "idempotencyKey": "…" }
```

- `amountMinutes` is a signed integer, not 0 (`amount_zero`). The bound is `|amountMinutes| ≤ 999999`, else `amount_out_of_range {max_minutes: 999999}`. A non-integer is refused by binding with 400.
- A top-up code sent here is answered 400 `reason_code_invalid`, with `valid` listing the four adjustment codes.
- It posts one `AdminAdjustment` row with `ZarPaid = null`.
- **The adjustment may take a balance below zero, as it does today.** The adjust route has no `allowNegativeBalance` flag and does not gain one (§12.8). `allowNegativeBalance` stays on the booking routes only.
- It records change action `credit.adjusted` and mails `EmailTemplates.MinutesAdjusted` (§6).
- It answers the same shape as `/sell` without `package` and with `zar_received: null`.
- The `snake_case` aliases `reason_code` and `zar_received` stay bound on both routes, as they are today.

### 3.8 Groups and tariff

**Group wire** (`GET /api/v1/admin/member-groups`, the POST and PATCH answers):
- `credits_per_zar` and the whole `pricing` object are **removed**;
- `package_discount_bps: int|null` is **added**;
- `caps`, `windows`, `peak_priority`, `system_key` and `member_count` are unchanged.

**Group request** (POST, PATCH): `packageDiscountBps` or `package_discount_bps` is tri-state, the same pattern as `credits_per_zar` today:
- absent leaves it unchanged;
- `null` clears it;
- an integer sets it.

Out of 0..10000 or not an integer: 400 `group_package_discount_invalid {min: 0, max: 10000}`.

**Group change-record snapshot** (`MemberGroupChanges.Snapshot`): drop `pricing_mode`, `multiplier_bps`, `flat_slice_price_credits` and `credits_per_zar`, and add `package_discount_bps`. The console words it as "10% off packages", with null as "no say": "no say → 10%".

**Tariff** (`MemberTariff` / `MemberTariffs.Resolve`):
- `TopUpRate` becomes `int? PackageDiscountBps`.
- `RateGroup` becomes `DiscountGroup`.
- **The lowest `PackageDiscountBps` among the member's active groups that set one wins.** Null means no discount. A tie goes to the group first in the existing `ordered` order.
- `member_groups_enabled = false` does not switch it off, exactly as with the D2 rate.

**Tariff wire.** The keys `{ top_up_credits_per_zar, rate_group_id, peak_priority, peak_withheld_by }` become `{ package_discount_bps, discount_group_id, peak_priority, peak_withheld_by }` in:
- `AdminMemberDetailEndpoints`;
- `AdminMemberGroupsEndpoint` (the PUT answer);
- `MemberGroupEndpoints.TariffWire` (rules and preview);
- `MemberGroupAudit` (`tariff_before` / `tariff_after`).

`GET /api/v1/me/profile`: `top_up_credits_per_zar` becomes `package_discount_bps`.

**The group preview / booking-rules read** (`ResolvedAsync`): drop `slice_price_credits`, `slice_price_range_credits` and `slice_prices_by_court`. The caps, windows and `tariff` stay.

The deprecated `member_class` disappears from every response that is rewritten here: the options route is gone, and `minutes.purchased` replaces the event. It stays where D2 left it otherwise: the admin members list and spend, and the `member.*` webhooks.

### 3.9 Settings and courts

`GET /api/v1/admin/settings` drops four keys:
- `slice_price_credits`;
- `credits_per_zar_regular`;
- `topup_block_zar`;
- `topup_max_zar_per_member`.

`penalty_pct`, `share_lapse_hours` and `topup_failure_cooldown_minutes` stay.

The `PUT` **binds and ignores** `slicePriceCredits`, `creditsPerZarRegular`, `creditsPerZarLeague`, `topupBlockZar` and `topupMaxZarPerMember`, whatever they hold. This follows the hygiene rule in `memory/decisions-backend-hygiene.md`. `credits_per_zar_league_moved_to_groups` is no longer returned (§12.9).

The settings label for `penalty_pct` becomes "Penalty (% of the booking's minutes)".

Courts (`/api/v1/admin/courts`):
- The list, create and update lose `slice_price_credits` / `slicePriceCredits`, and `price_negative` goes.
- The court change-record snapshot drops `slice_price_credits`.

### 3.10 Live balance stream (`GET /api/v1/wallet/stream`)

There are two frames per movement, as today.
- **Unnamed legacy frame:** `{ "balance_minutes": int }`.
- **Named `balance` event:** `{ balance_minutes, delta_minutes, reason, at, held_minutes, owed_back_minutes, spendable_minutes, held_until, held_parts: [{minutes, until}] }`.

`reason` keeps its closed set: `top_up | admin_adjustment | admin_top_up | booking_charge | cancellation_refund | penalty | lights_purchase | share_transfer | correction | mixed | share_set_aside | outage_refund | outage_refund_reversed | no_show_settled | no_show_reversed | pay_for_refund | pay_for_charge | displaced_refund | displaced_reinstated | cancelled_no_refund | cancelled_share_stands` (eight of these since review round 10, E10-1; `cancelled_no_refund` since R14, a delta-0 frame telling the booker the club cancelled a started session; a real cancellation keeps `cancellation_refund`; `cancelled_share_stands` since R16 J16-7, the same delta-0 frame — no parts, `cancelled_by: "club"`, `court_name`, `booking_starts_at` — sent to each accepted partner of that started session who was not settled by hand, telling them their share stands).

The named event also carries `parts` (R10 E10-1) — each row `{reason, delta_minutes}`, summing to `delta_minutes` (`[]` on `share_set_aside`); `share_cause` (R11 E11-1) — null unless a `share_transfer` row moved, else one of `share_paid | club_collected | attended | share_returned | organiser_removed | split_changed | player_added | club_settled | share_back | booking_cancelled | club_removed | outage_refund | no_show | displaced` (direction is the sign of `delta_minutes`; `share_returned` is a withdrawal only since R14 — the partner withdrew; `player_added` since R16 J16-2 — a player joined and an equal/ratio split went down); `actor_name` — the other player whose act moved the share, null for the member's own act, the system, an admin, `share_paid`, `club_settled` and `share_back` (R14; on `player_added` it names the organiser who added, null when the club did); a frame with `reason: cancelled_no_refund` moves nothing (delta 0, no parts) and exists to tell the booker the club cancelled a started session; and `share_kept_minutes` — with `no_show` only: the partner's part of the no-show penalty that did not come back. The same keys are used on `GET /api/v1/wallet`, together with `entries`, `total_entries`, `offset`, `limit` and `share_bookings`.

**One action, one frame (R12 C1, R13 C13-2).** A cancellation of a shared booking, the no-show /
outage sweep and a late check-in's reversal each send ONE named frame per member, not a settlement
frame followed by a `share_transfer` frame: `reason` is the settlement's (`cancellation_refund`,
`no_show_settled`, `outage_refund`, `no_show_reversed`, `outage_refund_reversed`), `delta_minutes` the
net of every row, and `parts` every row in order with the share rows last (one per partner, in seat
order). The frame also carries `cancelled_by` (`member | club`, on a cancellation — the partner's
share frame too; null otherwise) and `checked_in_by_name` (on a reversal, the scanner when it was
not this member; null for their own scan — and since R16 E16-3 on the booker's `cancelled_no_refund`
frame, whoever checked the started session in, null when it was the booker). Each `share_transfer` part names the other member on it,
`counterparty_name`, and a share frame carries `court_name` and `booking_starts_at` so a member no
longer on the game is still told which one (R13 C13-7). Backend: `NoShowWorker` holds a booking's
frames until its share follow-up has run (`Realtime/WalletFrameHolds`).

### 3.11 Quotes

**`GET /api/v1/admin/bookings/quote`:**

```json
{ "user_id", "court_id", "court_name", "starts_at", "ends_at", "slices",
  "price_minutes": 45, "balance_minutes", "balance_after_minutes", "spendable_minutes",
  "held_minutes", "owed_back_minutes", "overdraws": true }
```

`price_minutes` is `SliceMinutes × slices`. `overdraws` is `spendable_minutes < price_minutes`, exactly the guard behind 402.

**`POST /api/v1/admin/bookings/bulk/quote`:**

```json
{ "user_id", "total_minutes", "balance_minutes", "spendable_minutes", "held_minutes",
  "owed_back_minutes", "balance_after_minutes", "overdraws",
  "items": [{ "index", "court_id", "court_name", "starts_at", "slices", "price_minutes", "bookable", "reason" }] }
```

The per-row refusals (`reason`) and the before/after balances are kept.

**Booking create** (`POST /api/v1/bookings`, admin `POST /api/v1/admin/bookings`):
- 200 `{ booking_id, balance_after_minutes, players, players_error }`;
- 402 `{ error: "insufficient_balance", current_minutes, required_minutes }`.

### 3.12 The schedule read, without prices

On `GET /api/v1/schedule`, a free cell carries no price. The grid cell reads **"Free"**, and its spoken label drops the price. The book sheet and the selection bar compute the total as `slices × slice_minutes` and show it with the formatter: "45 min", "2 h 15 min left".

The slot field `amountChargedCredits` becomes `amountChargedMinutes`. It is on own bookings only, as today.

### 3.13 The booking-detail money block (`GET /api/v1/bookings/{id}`, `money`)

```json
"money": { "price_minutes", "organiser_owed_minutes", "shares_received_minutes",
           "organiser_net_minutes", "unpaid_minutes", "share_deadline", "is_split",
           "refunded_minutes", "penalty_minutes" }
```

The seat rows become `share_minutes`, `consented_minutes`, `paid_minutes`, `target_minutes`, `unpaid_minutes` and `returned_minutes`.

The accept sheet becomes `share_minutes`, `to_pay_minutes`, `balance_minutes`, `spendable_minutes`, `held_minutes`, `owed_back_minutes`, `balance_after_minutes` and `short_by_minutes`.

Upcoming games become `my_share_minutes`, `my_paid_minutes` and `my_owing_minutes`.

### 3.14 The cancel answer

`POST /api/v1/bookings/{id}/cancel` and the admin cancel answer:

```json
{ "refunded_minutes": 60, "penalty_minutes": 18, "net_minutes": 42,
  "partner_refunds": [{ "user_id", "name", "minutes" }] }
```

`net_minutes = refunded − penalty − Σ partner_refunds.minutes`. The bare `ToHttpResult` answer is `{refunded_minutes, penalty_minutes}`.

**A member cannot cancel a booking they have checked in to (R15 D15-5):** `409 {"error":"already_checked_in"}`. **Why:** the scan proved the court was used, a self-cancel refunds nothing, and the freed slot could be resold — the club would take the minutes twice for one lit slot. The admin cancel is not refused for a started or checked-in session, including the admin's own booking; it cancels with nothing refunded and the booker gets the `cancelled_no_refund` frame.

`GET /api/v1/bookings/{id}/cancellation-quote` uses the record shape in §3.3.

Bulk cancel uses `total_refunded_minutes`, `total_penalty_minutes`, and per result `refund_minutes`, `penalty_minutes` and `net_minutes`. Bulk book uses `total_charged_minutes`, and per result `amount_minutes`, `balance_before_minutes` and `balance_after_minutes`. Member bulk book adds `charged_now_minutes`.

### 3.15 Reports and CSV

| Route | Keys |
|---|---|
| `GET /api/v1/admin/reports/revenue` | `gross_topups_zar`, `reversals_zar`, `net_zar` (unchanged, rand); `gross_topups_minutes`, `reversals_minutes`, `net_minutes`; **new** `zar_per_minute_sold` = `net_zar ÷ net_minutes`, decimal rounded down to 4 dp, `null` when `net_minutes ≤ 0`; since R13 the minutes figures count paid packages only and **new** `given_minutes` carries free ones (reporting.md) |
| `GET /api/v1/admin/reports/utilisation` | `revenue_credits` → **`kept_minutes`** (charged minus refunded, net of penalties kept); `quoted_credits` → **`sold_minutes`** (Σ `AmountChargedMinutes`) |
| `GET /api/v1/admin/reports/daily`, `/reports/me/daily` | every `*_credits` → `*_minutes` (§3.2) |
| `GET /api/v1/reports/me/wallet` | `top_ups_minutes`, `spent_minutes`, `refunds_minutes`, `penalties_minutes`, `adjustments_minutes`, `reversals_minutes`, `share_transfers_minutes`, `net_court_spend_minutes`, `net_movement_minutes`. `minutes_on_court` is unchanged. |
| `GET /api/v1/admin/members/{id}/spend` | same renames |

CSV money columns are raw integers with no unit suffix:

| Export | Old header | New header |
|---|---|---|
| `/reports/me/wallet.csv` | `created_at,type,amount_credits,reason,external_reference,related_booking_id` | `created_at,type,amount_minutes,reason,external_reference,related_booking_id` |
| `/admin/members/{id}/trace.csv` | `…,court,amount_credits,balance_after_credits,source` | `…,court,amount_minutes,balance_after_minutes,source`, written as integers, not `"0.00"` (`AdminMemberTraceEndpoints` 384) |

`changes.csv` is unchanged: it carries the words, not the money.

### 3.16 Device endpoints

These are under `/api/v1/device`, authenticated by the device key. Every `*_credits` key becomes `*_minutes` with an integer value. The firmware reads none of them, only `amount_label` and the reason codes.

| Endpoint | Old keys | New keys |
|---|---|---|
| `POST /activate` (activated) | `amount_credits` | `amount_minutes` |
| `POST /activate` (insufficient) | `reason: "insufficient_balance"`, `current_credits`, `required_credits` | same reason, `current_minutes`, `required_minutes` |
| `POST /walkup` (grant) | `amount_credits`, `balance_after_credits` (plus `granted_minutes`) | `amount_minutes`, `balance_after_minutes`; `granted_minutes` unchanged |
| `POST /walkup` (402) | `current_credits`, `required_credits` | `current_minutes`, `required_minutes` |
| `POST /pay-for` quote | `{payable, reason, court_number, amount_credits, amount_label}` | `{payable, reason, court_number, amount_minutes, amount_label}`, same byte order |
| `POST /pay-for` confirm | `{paid, reason, court_number, amount_credits, amount_label, balance_after_credits, replayed, granted_seconds}` | `{paid, reason, court_number, amount_minutes, amount_label, balance_after_minutes, replayed, granted_seconds}`, same byte order |

**`amount_label`** comes from `DevicePayForEndpoint.Label(int minutes)` = `minutes.ToString(CultureInfo.InvariantCulture)`:
- whole digits only, with no sign, separator or decimal point;
- **1–4 characters**, for example `"45"`, `"9999"`;
- a price above 9999 minutes is refused `amount_unshowable` before any money moves.

`MaxLabelLength` stays 6 as the wire bound. The 4-digit bound is the content rule.

Echo-matching, `price_changed`, the nonce pinning, and the reason codes `insufficient_balance`, `price_changed`, `split_booking` and `not_chargeable` are all unchanged. The amount charged is `AmountChargedMinutes`.

The corpus (`src/contracts/device-protocol/membercode/http.json`, generated by `src/iot/tools/membercode_vectors.py` 1043–1099) changes like this:
- `amount_credits: 50.0` becomes `amount_minutes: 50`;
- `balance_after_credits: 118.0` becomes `balance_after_minutes: 118`;
- the `32.5` and `9999.5` label cases are deleted, and an integer `"9999"` case is added;
- the `12345.5` too-long case becomes `12345` (`amount_unshowable`).

---

## 4. Packages

### 4.1 Fields and validation

The fields are in §2.3 and the validation codes in §3.5. A package's `GroupId` is fixed at creation. A package is archived, never deleted.

### 4.2 The shelf rule

For member *m*, with active groups *G* (archived groups excluded):

1. **The discount.** `d` is the lowest `PackageDiscountBps` set among *G*, and the group it came from is the `discount group`. Null when none of *G* sets one.
2. **Club packages.** Every `Active` package with `GroupId = null`, at `price_zar = floor_cent(PriceZar × (10000 − d) ÷ 10000)`, with `discount_bps = d ?? 0`.
3. **Group packages.** Every `Active` package whose `GroupId ∈ G`, at its own `PriceZar` with no discount on top (`discount_bps = 0`).
4. **The shelf** is (2) ∪ (3), ordered by `sort_order` ascending, then `minutes` ascending, then `name`.

Dean's answer 2: a member of a group that has its own packages sees **both** that group's packages **and** the club packages (the club ones at the member's discount).

### 4.3 The saving

This is computed on the server, per shelf, and is a pure function, so it has unit tests.
- The **baseline** is the shelf item with the smallest `minutes`. A tie goes to the lower `price_zar`, then to the shelf order.
- For each item *p* other than the baseline:
  - `saving_zar = floor_cent(baseline.price_zar × p.minutes ÷ baseline.minutes − p.price_zar)`;
  - `saving_pct = floor(100 × (1 − (p.price_zar × baseline.minutes) ÷ (p.minutes × baseline.price_zar)))`.
- Show a saving only when `saving_zar > 0`; otherwise both are `null`. When `saving_pct` comes out as 0, it is `null`.
- The baseline itself always has `null`.

Check: with 1 h R120, 5 h R550 and 10 h R1000, the 5 h package saves **R50 (8%)** and the 10 h package saves **R200 (16%)**. At a 10% discount these become R45 and R180, with the same percentages.

### 4.4 The purchase lock and the ITN

- The lock is the `pending_topups` row: `PackageId`, `PackageName`, `Minutes`, `ListPriceZar`, `DiscountBps`, `GroupId` (the discount group) and `AmountZar`.
- It is written from the live shelf item at `POST /minutes/purchase` time.
- It is refused with `package_price_changed` when `quotedPriceZar ≠ price_zar`.
- **The ITN credits `pending.Minutes`.** It never reads `minute_packages`.
- The amount-mismatch check compares against `pending.AmountZar`.
- The callback route is unchanged.

### 4.5 Change-record actions

These are new; the area is `credit`, and none is reason-required:

| Action | Headline | Subject |
|---|---|---|
| `package.created` | `Created a minutes package — {name}` | `package` |
| `package.updated` | `Changed a minutes package — {name}` | `package` |
| `package.archived` | `Archived a minutes package — {name}` | `package` |

These existing codes are kept, with new words (§6):

| Action | Headline |
|---|---|
| `credit.adjusted` | `Adjusted a member's minutes — {name}` |
| `credit.topped_up` | `Sold a member a package — {name}` |

A group's discount edit is recorded on `group.updated` through the snapshot key `package_discount_bps`.

### 4.6 The seeded packages

Three club packages (`GroupId = null`) are seeded **only when the club has no `minute_packages` row at all**. Seeding is idempotent and never touches an edited shelf.

| Name | Minutes | PriceZar | SortOrder |
|---|---|---|---|
| `1 hour` | 60 | 120.00 | 0 |
| `5 hours` | 300 | 550.00 | 1 |
| `10 hours` | 600 | 1000.00 | 2 |

They are written by both `Persistence/Seeder.cs` (development) and `Persistence/ProductionBootstrap.cs` (a new club). The league system group is left with `PackageDiscountBps = null`.

`docs/specs/client-blueprint-deltas.md` gains deviation **D-3**, recorded below. D-2 is already taken (§12.1).
- **Blueprint text.** A.8 (credits at 160 or 240 per R100) and A.3 (R100 blocks, R1000 cap) become minute packages with no cap.
- **Status.** Decided by the founder on 2026-10-01. No committee step, by Dean's answer 3.

---

## 5. Webhook events and payload keys

The event names become constants in one new file, **`Webhooks/MinutesEvents.cs`** (B0). `WebhookEventCoverageTests` pins them.

| Old event | New event | Emitted by |
|---|---|---|
| `credit.topped_up` | `minutes.purchased` | the PayFast callback |
| `credit.refunded` | `minutes.refunded` | `LedgerService.MirrorAsync` (`CancellationRefund`) |
| `credit.penalty_applied` | `minutes.penalty_applied` | MirrorAsync (`NoShowPenalty`, `LateCancellationPenalty`) |
| `credit.adjusted` | `minutes.adjusted` | MirrorAsync (`AdminAdjustment`) |
| `credit.topped_up_by_admin` | `minutes.sold_at_desk` | MirrorAsync (`AdminTopUp`) |
| — (was `minutes.refunded` with a negative figure) | `minutes.refund_reversed` | MirrorAsync (`CancellationRefund` < 0; review round 6, E6-11) |
| — (was `minutes.penalty_applied` with a positive figure) | `minutes.penalty_returned` | MirrorAsync (`NoShowPenalty` / `LateCancellationPenalty` > 0; E6-11) |

**`minutes.purchased` data:**

```json
{ "purchase_id", "package_id", "package_name", "minutes": 300, "list_price_zar": 550.00,
  "discount_bps": 1000, "zar_paid": 495.00, "discount_group_id": "uuid|null",
  "groups": [{ "id", "name", "system_key" }], "external_reference": "pf id" }
```

Old to new keys: `topup_id` becomes `purchase_id`, `credits` becomes `minutes`, and `rate_group_id` becomes `discount_group_id`. `conversion_rate` and `member_class` are removed (§12.10).

**Mirror data** (the six MirrorAsync events): `{ entry_id, user_id, entry_type, amount_minutes, booking_id, reason }`.

**Every other event's `data`** follows the §3.2 table, for example `booking.created` `amount_minutes` / `balance_after_minutes`, `booking.no_show` `penalty_minutes` / `refund_minutes`, and `lights.*` `amount_charged_minutes`.

**`topup.failed` is not a webhook.** It is an admin-notice kind (`AdminEventCatalogue.TopUpFailed`), and **it keeps its code**. Admins' stored opt-outs and the outbox `DedupeKey`s name it, and those tables are not reset (§12.2). Its display name becomes "Package purchases that need looking at". Its payload `TopUpFailure` gains `PackageName` and `Minutes`.

`docs/specs/webhooks.md` (B4) is updated to match. The doc's stale `amount_charged_zar` / `balance_after_zar` example becomes the real keys.

---

## 6. Email and receipt wording

**Rules:**
- No email, receipt, ledger reason or webhook string says "credit" or "cr".
- Minutes in prose use `MoneyFormat.Minutes` (§7.2). Rand uses `EmailTemplates.Zar` with the club's symbol.
- `EmailTemplates.Cr` is replaced by `EmailTemplates.Min(int)` => `MoneyFormat.Minutes`. There are about 90 call sites in `EmailTemplates*.cs`, `EmailChromeBlocks.cs` and `ReceiptPdf.cs`.
- A figure that is minutes never carries a currency symbol. A figure that is rand always does.
- "Balance" means minutes: "Balance after: 2 hours 15 minutes".
- The verb is **buy** ("Buy minutes", "package"), never "top up", in member-facing words. Ledger type names and admin-notice codes keep "top up" (§2.5, §5).

| Template (B4) | Replaces | Signature (callers in B2 / B1 build against it) | Must show |
|---|---|---|---|
| `PurchaseConfirmation(ClubIdentity club, string to, PackagePurchaseReceipt r)` | `TopUpConfirmation` / `TopUpReceipt` | `PackagePurchaseReceipt(string PackageName, int Minutes, decimal ListPriceZar, int DiscountBps, string? DiscountGroupName, decimal AmountZar, int BalanceAfterMinutes, string Reference, string CurrencySymbol)` | the package name; the minutes added; the list price; the discount line **only when `DiscountBps > 0`** ("10% off — League"); the amount paid; the PayFast reference; the balance after |
| `PurchaseNotCompleted(ClubIdentity club, string to, string packageName, int minutes, decimal amountZar, string? failureReason, string reference, string currencySymbol)` | `TopUpNotCompleted` | | "Minutes added: 0 minutes" replaces `Cr(0)` |
| `MinutesAdjusted(ClubIdentity club, string to, int amountMinutes, int balanceAfterMinutes, string reason)` | `CreditAdjustment` | | "+1 hour" / "−45 minutes", the balance after, the reason given |
| `PackageSoldAtDesk(ClubIdentity club, string to, string packageName, int minutes, decimal zarReceived, int balanceAfterMinutes, string currencySymbol)` | (new; a desk top-up used `CreditAdjustment`) | | the package, the minutes added, the amount received, the balance after |
| Penalty sentence (`EmailTemplates.cs` 471) | | | "{penalty_pct}% of the booking's minutes ({Min(penalty)})" |
| `ReceiptPdf.ForBooking(…, int amountMinutes, int balanceAfterMinutes, …)` | credit figures | | "Charged: 45 minutes", "Balance after", and the footer "Times are this club's local time. Minutes are its unit of account." This is a **booking** receipt; the package details go in `PurchaseConfirmation` (§12.5). |

Ledger `Reason` strings are written once and read for ever. New rows use the new words. Old rows are not rewritten, and none exist after the reset.

---

## 7. Display formatter rules

### 7.1 Frontend: `src/frontend/src/lib/minutes.ts` (0a) and `src/frontend/src/components/Minutes.tsx` (0a)

| Export | Input → output |
|---|---|
| `minutesCompact(n: number): string` | `0` → `"0 min"` · `45` → `"45 min"` · `60` → `"1 h"` · `90` → `"1 h 30 min"` · `1440` → `"1 d"` · `1815` → `"1 d 6 h 15 min"` · `-90` → `"−1 h 30 min"` |
| `minutesSigned(n: number): string` | `60` → `"+1 h"` · `-45` → `"−45 min"` · `0` → `"0 min"` (no sign) |
| `minutesSpoken(n: number, opts?: { signed?: boolean }): string` | `90` → `"1 hour 30 minutes"` · `1` → `"1 minute"` · `-45` → `"minus 45 minutes"` · `3060` → `"2 days 3 hours"` · signed `60` → `"plus 1 hour"` · `0` → `"0 minutes"` |
| `<Minutes value={n} signed? className? />` | renders `<span aria-hidden="true">{compact or signed}</span><span className="sr-only">{spoken}</span>` with `tabular-nums`. A negative value uses the existing negative tone. |

**Rules:**
- The output is exact and never rounds.
- Days are shown from 1440 upward (`d`, `h`, `min`). Zero parts are left out.
- A negative value gets **one** leading U+2212 on the whole value, never `"−1 h −30 min"`.
- **Never `hh:mm` for an amount.** `hh:mm` stays for clock times and `mm:ss` for countdowns.
- Never a decimal: a non-integer input is truncated toward zero, and a unit test pins this.
- Screen readers never hear "h", "d" or "min". The spoken form uses `memberDoorCopy.formatWindowMinutes`'s wording. `wallet-chip-a11y` follows the same rule.
- `formatCredits` and `formatSignedCredits` (`utils.ts`) and `courtsCopy.formatCredits` stay, marked `@deprecated`, until phase 2 deletes them. The duration helper `utils.formatMinutes` is a duration, not an amount. It stays, and it is never used for a balance.
- `lib/viewerPrice.ts` is deleted (F1).
- The count-up (`useCountUp`) animates integers.
- `lib/amount.ts` parses a minutes field with **0 decimals** and a rand field with 2.

### 7.2 Backend: `Services/MoneyFormat.cs` (B0)

| Member | Output |
|---|---|
| `MoneyFormat.Minutes(int n)` | prose for emails, receipts and ledger reasons: `"45 minutes"`, `"1 minute"`, `"1 hour 30 minutes"`, `"2 hours"`, `"1 day 6 hours 15 minutes"`, `"0 minutes"`, `"−45 minutes"` (one U+2212). Days from 1440 upward, zero parts omitted. |
| `MoneyFormat.MinutesCompact(int n)` | `"5 h"`, `"45 min"`, `"1 h 30 min"`, the same rules as the frontend compact form. Used for the PayFast `item_name`. |
| `MoneyFormat.MinutesLabel(int n)` | the device label, `n.ToString(InvariantCulture)`, for example `"45"`. Callers check `0 < n ≤ 9999`. |
| `MoneyFormat.Money(decimal, symbol)`, `Number(decimal)` | unchanged |
| `MoneyFormat.Credits` | **deleted** |

---

## 8. Firmware strings (bridge only) and `amount_label`

These changes are all in `src/iot/court-box/lib/bridgelogic` on the ESP8266. **The Mega stays 2.0.0, unflashed. The wiring and the door gate are untouched, and so is the serial protocol.** Every row fits the 16-column safe subset.

| Where | Old | New |
|---|---|---|
| `ScreenScript.cpp` 297, `PayForQuote` row 1 | `"PAY "` + amount + `"cr?"` | `"PAY "` + amount + `" MIN?"` (longest `PAY 9999 MIN?`, 13 columns) |
| `ScreenScript.cpp` 304, `PayForPaid` row 1 | amount + `"cr CHARGED"` | amount + `" MIN PAID"` (longest `9999 MIN PAID`, 13 columns) |
| `ScreenScript.cpp` 101–103, `InsufficientBalance` | `TOO FEW CREDITS` / `Top up to play` / `Top up in the app` | `TOO FEW MINUTES` / `Buy more time` / `Buy in the app` |
| `ScanFlow.cpp` 23, `WalkUp.cpp` 39 and 116 | `TOO FEW CREDITS` / `TOP UP & RETRY` | `TOO FEW MINUTES` / `BUY & RETRY` |
| The comments at ScreenScript 290–294 (`PAY 50cr?`) | | updated to the new strings |

**`validAmountLabel` (`PayFor.cpp` 68–90)** accepts **1–4 ASCII digits and nothing else**: no point, no sign and no leading `.`. A leading zero is accepted only for `"0"`. `kMaxAmountLabelLen` stays 6, because it sizes the buffer.

**Version.** The bridge goes to **2.2.0**: `platformio.ini` 269 `-DFW_VERSION_MINOR=2` in `[env:court_bridge]`, and the `build_unflags` at 292 is unchanged (`-DFW_VERSION_MINOR=0`). The file's version history gains a 2.2.0 "BRIDGE ONLY" line.

**Then:**
- `make arduino-export`, with `make arduino-check` showing `court_mega` unchanged;
- the vector and corpus changes in §3.16, then `make corpus-check`;
- the screen tests and the decoy strings in `test_bridgelogic.cpp` 542–544 and 697 move to the `*_minutes` names;
- `docs/court-lights-flows.html` 443 and 541 and `docs/system-blueprint.html` are regenerated (B3).

**Until it is reflashed,** an old 2.1.0 bridge shows "PAY 45cr?" with a minutes number. The wording is wrong, but nothing breaks: an integer label passes the old check. One flash covers both 2.1.0 and 2.2.0.

---

## 9. The fingerprint UI, hidden behind one switch

Dean's answer 4. **The switch is `FEATURES.fingerprintEnrolment`**, in a new file `src/frontend/src/lib/features.ts` (F3):

```ts
/** Product switches. One constant per switch; flipping one is the whole change. */
export const FEATURES = {
  /** Court-box fingerprint enrolment in the admin console. Off until the court box reads fingerprints (P13, Dean 2026-10-01). */
  fingerprintEnrolment: false,
} as const;
```

When it is `false`:
- **Member detail.** The Access tab's "Court-box fingerprints" section is not rendered: the `COPY.fingerprintsTitle` section, `EnrolFingerDialog` and the `Fingerprints` list in `pages/admin/member/MemberAccess.tsx`. Neither is the Overview fact "fingers enrolled" in `MemberOverview.tsx` 120.
- **Members list.** The row action "Enrol a fingerprint" / "Manage fingerprints" (`components/members/RowActions.tsx` 106) and its `FingerprintsDialog` are not offered. `useFingerprints` in `pages/AdminMembers.tsx` **issues no request**.
- **Capture.** No capture or enrolment UI can be reached.

These are not affected:
- The backend and its endpoints, which are kept and still tested.
- Passkey ("fingerprint" icon) sign-in in `Login.tsx` and `Profile.tsx`. That is WebAuthn, not the court box.

A test renders each surface with the switch on and off. Turning it back on is one change.

---

## 10. Lane ownership and ordering

### 10.1 Phase 0

| Lane | Owns |
|---|---|
| **0a Integrator: contract** (this document, then the frontend half of 0a, i.e. **F0**) | this file; `lib/api.ts`, `adminApi.ts`, `bookingsApi.ts`, `playersApi.ts`, `memberDetailApi.ts` (every type in §3); `lib/minutes.ts`; `components/Minutes.tsx`; `src/test/harness.tsx`, `setup.ts`, `src/test/*Fixtures.ts`, `bookingsKit.tsx`, `changeRecordCatalogue.ts`; `e2e/fixtures.ts`. `formatCredits` is left in place, deprecated. |
| **B0 Backend foundation** (after this document; alongside F0) | all of `Domain/*`; `Persistence/MainframeDbContext*.cs`; the migration `MinutesReplaceCredits` and its snapshot; `LedgerService` / `LedgerPosting`; `MoneyFormat`, `MoneySettings`, `TenantSettingsAccessor`; `Webhooks/MinutesEvents.cs`; `Program.cs`. A **mechanical, compile-clean** rename across all of `src/backend` (types, `*Credits` → `*Minutes`, `decimal` → `int` on the money path, `*_credits` keys per §3.2, event constants per §5). The go-live reset step. **No later lane adds schema.** |

### 10.2 Phase 1: eight lanes in parallel

These are copied from the plan, with the paths corrected to the source and the files the plan left without an owner added.

| Lane | Owns |
|---|---|
| **B1 Bookings** | `Services/BookingService.cs`, `BookingRules.cs`, `GroupRules.cs`, `ScheduleService.cs`, `ScheduleSpec.cs`, `MemberBulkBookingService.cs`, `AdminBulkBookingService.cs`, `BulkBookingResults.cs`, `BulkReplay.cs`, `BulkSettings.cs`, `AdminBlockService.cs`, `CourtActivationService.cs`, `BookingScheduleService.cs`, `ControlBoardReader.cs`, `Webhooks/NoShowWorker.cs`, `Webhooks/LightsCueWorker.cs`, `Endpoints/BookingEndpoints.cs`, `MemberBulkBookingEndpoints.cs`, `AdminBulkBookingEndpoints.cs`, `AdminScheduleEndpoints.cs`, `AdminCancelRecord.cs`, `AdminCourtEndpoints.cs`, `DeviceEventEndpoints.cs`, `docs/specs/settlement-model.md`, and their tests |
| **B2 Packages and groups** | `Endpoints/TopUpEndpoints*.cs`, the new `PackageEndpoints.cs` and `AdminPackageEndpoints.cs`, `Payments/**`, `Workers/TopUpExpiryWorker.cs`, `Services/TopUpAlerts.cs`, `MemberTariffs.cs`, `PayerLock.cs`, `CurrencySymbol.cs`, `AdminChangeActions.cs`, `AdminChangeAreas.cs` (subjects), `Endpoints/MemberGroup*.cs` (endpoints, validation, changes, audit), `AdminMemberGroupsEndpoint.cs`, `WalletEndpoints.cs`, `AdminCreditReasons.cs`, `AdminConfigEndpoints.cs`, `Persistence/Seeder.cs`, `MemberGroupSeeder.cs`, `ProductionBootstrap.cs`, the compose files and `.env.example`, `docs/specs/payments-payfast.md`, `docs/specs/client-blueprint-deltas.md` (D-3), and their tests |
| **B3 Players, pay-for and firmware** | `Services/Players/**`, `Endpoints/PlayersEndpoints.cs`, `InviteLookups.cs`, `DevicePayForEndpoint.cs`, `CourtActivationResponse.cs`, `src/iot/court-box/**`, `src/iot/tools/membercode_vectors.py`, `src/contracts/device-protocol/**`, `docs/specs/players-and-splits.md`, `member-code.md`, `docs/court-lights-flows.html`, `docs/system-blueprint.html`, and their tests |
| **B4 Communications and reads** | `Email/**`, `Services/AdminEventCatalogue.cs`, `TraceKinds.cs`, `Endpoints/ReportingEndpoints.cs`, `AdminLedgerEndpoints.cs`, `AdminMemberTrace*.cs`, `AdminMemberDetailEndpoints.cs`, `AdminMemberEndpoints.cs`, `MeProfileEndpoints.cs`, `AdminChangeEndpoints.cs`, `AdminChangeQuery.cs`, `docs/specs/webhooks.md`, `reporting.md`, and their tests |
| **F1 Bookings and players screens** | `components/bookings/**`, `ScheduleCells.tsx`, `components/schedules/**`, `pages/Schedule.tsx`, `BookingDetail.tsx`, `AdminScheduleDetail.tsx`, deleting `lib/viewerPrice.ts`, `lib/grid*.ts`, `scheduleGrid.ts`, `scheduleCopy.ts`, `bookings*.ts`, `bookingErrors.ts`, `bookingOutcome.ts`, `groupRules.ts`, `components/players/**`, `playersCopy.ts`, `pages/Invites.tsx`, `InviteLink.tsx`, `components/ui/split-view.tsx` (copy line), `components/ui/member-combobox.tsx` |
| **F2 Wallet and buying** | `pages/TopUp*.tsx` (become the `/wallet/buy` pages), `Wallet*.tsx`, `Home.tsx`, `components/wallet/**`, `components/shell/CreditsChip.tsx` (renamed `MinutesChip`), `AppShell.tsx` (the import), `chipBalance.ts`, `shareMovement.ts`, `AccountMenu.tsx`, `NotificationBell.tsx`, `components/notifications/**`, `member-code/WalletGlance.tsx`, `lib/balance.tsx`, `liveBalance.ts`, `walletCopy.ts`, `topUp*.ts`, `zeroBalanceEntice.ts`, `currency.ts`, `amount.ts`, `amountCopy.ts`, `useCountUp.ts`, `LedgerTable.tsx`, `ledgerCopy.ts`, `lib/offline/memberStore.ts` (`VERSION` 1 → 2, line 28) |
| **F3 Admin money screens** | `pages/AdminGroups.tsx`, `components/groups/**`, the new `pages/admin/AdminPackages.tsx`, `AdminSettings.tsx`, `settingsSchema.ts`, `settingsCopy.ts`, `components/settings/**`, `AdminCourts.tsx`, `AdminMembers.tsx`, `components/members/**`, `pages/admin/member/**`, `AdminLedger.tsx`, `components/admin/LedgerDetailSheet.tsx`, `adminPaging.ts`, `changeRecordCopy.ts`, `pages/monitoring/AdminChangeRecord.tsx`, `pages/AdminWebhooks.tsx`, `groups*.ts`, `courtsCopy.ts`, `members*Copy.ts`, `memberDetailCopy.ts`, `creditAdjustment.ts`, `settingsSummaries.ts`, `ecoSettings.ts`, `tenantSettings.ts`, **`lib/features.ts` and the fingerprint switch (§9)** |
| **F4 Reports, onboarding and copy** | `Reports.tsx`, `AdminReports.tsx`, `components/reports/**`, `Charts.tsx`, `Inbox.tsx`, `inboxCopy.ts`, `components/onboarding/**`, `onboardingCopy.ts`, `setupChecklist.ts`, `authCopy.ts`, `ClubButtonMapCard.tsx`, `HowItWorks`, `GetStarted`, `Welcome`, `monitoring/MemberNight.tsx`, `nightCopy.ts`, `playCopy.ts`, `pages/dev/**` |

Each lane also owns its own end-to-end spec files and its own `*.test.*` files beside the files it owns.

**Integrator-owned throughout:**
- `App.tsx` (the `/wallet/buy`, `/admin/packages` and redirect routes) and `routeAnnouncer.ts`;
- `lib/api*.ts` and the API modules in §10.1;
- `components/admin/adminNav.ts` (the Packages entry);
- `src/test/harness.tsx`, `src/test/setup.ts` and `e2e/fixtures.ts`;
- `package.json`, `tailwind.config.ts`, `index.css`, `lib/tokens.ts`, `lib/typography.ts`, `components/ui/icons.ts` (a clock or hourglass icon) and `vite.config.ts`;
- `.github/**`;
- `CLAUDE.md` and the memory topics: `decisions.md`, `-groups`, `-topups`, `-players*`, `-member-code*` and `-frontend-*`.

**Incidental mentions** in backend files no lane above names (comments only: `AuthService.cs`, `SecurityHeaders.cs`, `TenantResolutionMiddleware.cs`, `IdentificationResolver.cs`, `MembershipAccess.cs`, `Play/StreakMath.cs`, `Domain/AuditLog.cs`, `Domain/Tenant.cs`) are B0's mechanical pass.

### 10.3 Ordering

1. **This document** comes before everything else.
2. **B0** comes before B1 to B4. **F0** comes before F1 to F4. B0 and F0 run together.
3. The B2 purchase-completion record shape (`PackagePurchaseReceipt`, §6) and the desk template signatures are fixed here, so B4's email work does not wait on B2.
4. B3's firmware work depends only on this document (§8, §3.16).
5. **Phase 2 (integrator):**
   1. Delete the deprecated formatters, and run the "credit" scan down to the §2.5 allow-list.
   2. Wire `App.tsx` and `routeAnnouncer`.
   3. Run `make lint test test-integration test-iot corpus-check arduino-check` and the device end-to-end run.
   4. Hand over to refuter rounds, until two consecutive rounds find nothing high (`memory/decisions-method.md`).

New backend tests that are non-negotiable:
- a **cross-tenant injection test** for `minute_packages`, for the purchase routes, and for the desk shelf and sell;
- the purchase lock (price, discount and minutes);
- an amount mismatch;
- a late COMPLETE after a cancel return;
- the saving as pure functions;
- the migration refusal;
- the unit guard and the source scan (§1.3).

---

## 11. Settled by Dean (2026-10-01): binding

1. **The spend cap is removed entirely** (§3.6). Listing open checkouts and the cancel return stay.
2. **Group shelf:** group packages **and** club packages, the club ones at the member's discount (§4.2).
3. **Sign-off:** Dean's call is enough. Recorded as a deviation with no committee step (§4.6).
4. **Fingerprints:** the admin enrolment UI is hidden behind one switch, and the backend is kept (§9).
5. **Whole minutes everywhere**, never "100.00" (§1, §7).
6. **Firmware flashes are fine.** Carl's wiring is never changed and the Mega is never touched (§8).

Defaults kept from the plan: lowest discount wins; penalties and partner shares round down; discounts apply to rand only and round down to the cent; days are shown from 24 h; the grid shows no price; bought minutes never expire; League starts with no discount; the PayFast callback URL and the ledger type names stay.

---

## 12. Where this contract departs from the plan, and why

1. **The deviation is D-3, not D-2.** `client-blueprint-deltas.md` already has "D-2 — firmware is signed with RSA-2048". It also covers A.3, because Dean removed the cap the blueprint names.
2. **`topup.failed` keeps its name.** It is an admin-notice kind (`AdminEventCatalogue`), not a webhook. Admins' stored opt-outs and the outbox dedupe keys name it, and those tables survive the money reset. Renaming it would silently drop every opt-out.
3. **The change-record codes `credit.adjusted` / `credit.topped_up`, the area `credit` and the audit action `credit.adjusted` keep their codes.** They are stored in append-only tables. Only their words change (§4.5). The plan's rename covered the webhook events only, and those are renamed.
4. **The migration refuses on any charged booking or non-zero share as well**, instead of filling `bookings` with `SliceMinutes × SliceCount`. On an empty ledger the only bookings left are uncharged (blocks), and writing a charge with no ledger debit would break invariant 3.
5. **`ReceiptPdf` is a booking receipt** (`ForBooking`). The package, list price, discount and reference belong in `PurchaseConfirmation`, the completion email. The receipt only changes its figures to minutes.
6. **A lit-time charge rounds the lit duration down** (the single payer-favour rule), where the plan said `min(minutes lit, …)` with "minutes lit" taken from `LitWindow.Minutes`. That value is computed with `Math.Ceiling` (`DeviceEventEndpoints.cs` 1285). It stays as it is for its non-money uses, and B1 derives the floor for the charge.
7. **The admin ledger `totals` `credits`/`debits`/`net` are renamed** to `in_minutes`/`out_minutes`/`net_minutes`. The plan did not list them. "credits" there is the accounting word, but it would survive the scan and confuse the unit.
8. **The adjust route has no `allowNegativeBalance`.** The plan said it is "kept", but the source has none: an adjustment already posts whatever it is told. The desk sale is a separate route (`/sell`) rather than a mode of `/adjust`, so the sale's `packageId` and the quoted price cannot be mixed with a signed goodwill amount.
9. **`creditsPerZarLeague` is now bound and ignored** instead of refused with `credits_per_zar_league_moved_to_groups`. There is no league rate left to point anyone to, and the hygiene rule covers retired keys.
10. **`minutes.purchased` drops `member_class`.** The event is renamed, so no template that names `{member_class}` on `credit.topped_up` can receive it. The one-release deprecation therefore has nothing to protect here.
11. **The open-checkout `counts_until` becomes `expires_at`.** With no cap, nothing "counts" until then. The row simply expires.
12. **The plan's file paths `Admin/MemberBulkBookingService.cs` and `Admin/MemberBulkBookingEndpoints.cs`** are `Services/…` and `Endpoints/…`. The plan's "about 70 keys in 42 files" is, in fact, 79 snake identifiers in 49 files, plus the camelCase and bare keys in §3.2 and §3.3.
13. **PayFast `item_name` uses an ASCII hyphen**, not the plan's en dash, so PHP-`urlencode` signature parity is not put at risk.
14. **The old SPA routes `/wallet/topup[/:id]` redirect** to `/wallet/buy[/:id]` instead of disappearing. A PayFast return in flight at deploy time lands on the old URL.
