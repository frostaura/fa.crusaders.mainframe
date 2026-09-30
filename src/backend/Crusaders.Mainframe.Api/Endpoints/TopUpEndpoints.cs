using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static partial class TopUpEndpoints
{
    public static IEndpointRouteBuilder MapTopUpEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/credit").RequireAuthorization();

        // What the top-up screen is allowed to offer, and at what rate.
        //
        // The screen used to carry `MIN_ZAR = 100`, `MAX_ZAR = 1000`, `BLOCK_ZAR = 100` and
        // two hardcoded conversion rates. An admin who moved any of them left the member
        // quoted 60% more credits than they would get, offered amounts the club had stopped
        // accepting and refused amounts it did accept — the screen disagreeing with the
        // server in both directions at once. Every configurable number is
        // tenant_settings.<key>; this is where the member's screen reads them.
        g.MapGet("/topup/options", async (
            HttpContext ctx,
            MainframeDbContext db,
            TenantSettingsAccessor settings,
            CancellationToken ct) =>
        {
            var s = await settings.GetAsync(ct);
            var userId = ctx.User.Id() ?? Guid.Empty;
            var tariff = await MemberTariffs.ForAsync(db, userId, s, ct);

            // What this member has already put in, so the screen can say "R200 of your R1000
            // left" instead of offering an amount the POST is about to refuse. The cap is per
            // MEMBER (D2-B05) and a screen that cannot see the running total can only ever
            // show the per-transaction half of it.
            var already = await ToppedUpZarAsync(db, userId, ct);
            return Results.Ok(new
            {
                block_zar = s.TopupBlockZar,
                min_zar = s.TopupBlockZar,
                max_zar = s.TopupMaxZarPerMember,
                already_zar = already,
                remaining_zar = Math.Max(s.TopupMaxZarPerMember - already, 0m),
                presets_zar = Presets(s.TopupBlockZar, s.TopupMaxZarPerMember),
                conversion_rate = tariff.TopUpRate,
                // D2: the group the rate comes from, or null for the club's default rate — so
                // the screen can say "League rate" in the club's own words.
                rate_group = RateGroupWire(tariff),
                // Deprecated for one release; derived from the league group. See MemberTariff.
                member_class = tariff.LegacyMemberClass,
            });
        });

        g.MapPost("/topup", async (
            TopUpRequest req,
            HttpContext ctx,
            MainframeDbContext db,
            IPaymentProvider provider,
            TenantSecretsAccessor secrets,
            TenantSettingsAccessor settings,
            IConfiguration config,
            Crusaders.Mainframe.Api.Multitenancy.ITenantContext tenant,
            Crusaders.Mainframe.Api.Services.Realtime.RealtimeOutbox outbox,
            CancellationToken ct) =>
        {
            var s = await settings.GetAsync(ct);

            // Blueprint A.3: top-ups in blocks of R100 to a max of R1000 for non-admin members.
            // Admins bypass the cap (their manual-adjustment path is the admin-unlimited route — this
            // endpoint is the member-facing PayFast flow).
            var isAdmin = ctx.User.IsInRole("admin");
            if (RefuseAmount(req.AmountZar, s, isAdmin) is { } refusal) return refusal;

            var creds = await secrets.GetPaymentsAsync(ct);
            if (creds is null) return Results.Json(new { error = "payments_not_configured" }, statusCode: 503);

            var userId = ctx.User.Id() ?? Guid.Empty;

            // M4-1: the ceiling is read and the new row written under the member's lock, so two
            // registrations sent together cannot both fit in the same remaining rand. Released
            // before the gateway is called.
            await using var capLock = await PayerLock.BeginAsync(db, tenant.TenantId, userId, outbox, ct);

            // D2-B05. The per-transaction half of the cap is above; this is the half the key's
            // own name promises and nothing implemented. See RefuseCumulativeAsync.
            if (await RefuseCumulativeAsync(db, userId, req.AmountZar, s, isAdmin, ct) is { } overCap)
                return overCap;

            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.Unauthorized();

            // The rate is captured HERE, with the offer, not re-resolved when the ITN lands.
            // See PendingTopup.ConversionRate: settling at the live rate meant an admin
            // editing credits_per_zar_* while a member sat on PayFast's card page changed
            // what that member got for money already paid.
            // D2: the rate is the member's GROUPS' (the lowest any of them sets, else the club
            // default), and the group it came from is locked beside it.
            var tariff = await MemberTariffs.ForAsync(db, userId, s, ct);
            var rate = tariff.TopUpRate;

            // ...and the offer the member is looking at has to still be this one.
            if (RefuseStaleQuote(req.QuotedConversionRate, req.AmountZar, tariff) is { } stale)
                return stale;

            var pending = new PendingTopup
            {
                TenantId = tenant.TenantId,
                UserId = userId,
                AmountZar = req.AmountZar,
                ConversionRate = rate,
                GroupId = tariff.RateGroup?.Id,
                IdempotencyKey = $"tu_{Guid.NewGuid():N}",
                Status = TopUpStatus.Pending,
            };
            db.PendingTopups.Add(pending);
            await db.SaveChangesAsync(ct);
            await capLock.CommitAsync(ct);

            var publicBase = config["App:PublicBaseUrl"] ?? "http://localhost:8089";
            var register = await provider.RegisterCheckoutAsync(new RegisterCheckoutRequest(
                creds, tenant.TenantId, userId, user.Email, req.AmountZar,
                pending.IdempotencyKey,
                ReturnUrl: $"{publicBase}/wallet/topup/{pending.Id}",
                NotificationUrl: $"{publicBase}/api/v1/credit/topup/callback?tenant={tenant.TenantSlug}")
            {
                // PayFast requires a cancel_url and it was never set, so the field was empty,
                // dropped from the signed list, and a member who backed out at the gateway had
                // nowhere to land. Same page as the return URL — it polls the status and will
                // show them the cancellation the ITN reports.
                CancelUrl = $"{publicBase}/wallet/topup/{pending.Id}?cancelled=1",
            }, ct);

            if (!register.Ok)
            {
                pending.Status = TopUpStatus.Failed;
                pending.FailureReason = FailureCodes.ProviderRegisterFailed;
                await TopUpAlerts.StageAsync(db, tenant.TenantId, pending, ct);
                await db.SaveChangesAsync(ct);
                return Results.Json(new { error = "provider_register_failed", reason = register.FailureReason }, statusCode: 502);
            }

            pending.GatewayCheckoutId = register.CheckoutId;
            await db.SaveChangesAsync(ct);

            // form_fields is the payment. PayFast has no server-side checkout registration —
            // the browser POSTs a SIGNED FORM to the process URL — and this endpoint used to
            // return the bare process URL and nothing else, which the frontend then followed
            // as a GET with no merchant id, no amount and no signature. No payment could
            // start. The provider had been building and signing the field list all along and
            // nothing outside its own unit test ever read it.
            return Results.Ok(new
            {
                topup_id = pending.Id,
                checkout_id = register.CheckoutId,
                redirect_url = register.RedirectUrl,
                form_fields = register.FormFields.Select(f => new { name = f.Key, value = f.Value }).ToList(),
                quoted_credits = Convert(pending.AmountZar, rate),
                conversion_rate = rate,
            });
        });

        g.MapGet("/topup/{topupId:guid}", async (Guid topupId, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var p = await db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == topupId && x.UserId == userId, ct);
            return p is null ? Results.NotFound() : Results.Ok(StatusWire(p));
        });

        // M4-1: the member came back through the cancel URL (TopUpEndpoints.Abandoned.cs).
        MapCancelReturn(g);

        // Callback — PayFast ITN. Anonymous and signed; identifies the tenant via querystring.
        app.MapPost("/api/v1/credit/topup/callback", async (
            HttpRequest http,
            MainframeDbContext db,
            IPaymentProvider provider,
            TenantSecretsAccessor secrets,
            TenantSettingsAccessor settingsAccessor,
            LedgerService ledger,
            IEmailService emailService,
            IEventBus bus,
            Crusaders.Mainframe.Api.Multitenancy.ITenantContext tenant,
            ClubIdentityResolver club,
            ILoggerFactory loggerFactory,
            CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("TopUpCallback");
            var mailer = new TopUpMailer(emailService, logger, club, settingsAccessor);
            var slug = http.Query["tenant"].ToString();
            if (string.IsNullOrEmpty(slug)) return Results.BadRequest(new { error = "tenant_missing" });

            var tenantRow = await db.Tenants.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Slug == slug, ct);
            if (tenantRow is null) return Results.NotFound();
            tenant.Set(tenantRow.Id, tenantRow.Slug);

            var creds = await secrets.GetPaymentsAsync(ct);
            if (creds is null) return Results.Json(new { error = "payments_not_configured" }, statusCode: 503);

            string raw;
            using (var sr = new StreamReader(http.Body, Encoding.UTF8, leaveOpen: true)) raw = await sr.ReadToEndAsync(ct);

            // PayFast posts application/x-www-form-urlencoded and signs the fields IN THE
            // ORDER SENT, so the raw body is parsed positionally. Using http.Form here would
            // hand back a sorted dictionary and every notification would fail to verify,
            // with nothing in the log saying why.
            var fields = ParseFormPreservingOrder(raw);

            var interp = await provider.InterpretCallbackAsync(
                new CallbackPayload(creds, raw, SignatureHeader: "", fields)
                {
                    SourceIp = http.HttpContext.Connection.RemoteIpAddress?.ToString(),
                }, ct);

            if (!interp.SignatureValid)
            {
                logger.LogWarning("topup callback signature invalid for tenant {Slug}", slug);
                await TopUpAlerts.RaiseAsync(db, tenantRow.Id, TopUpAlerts.SignatureInvalid, TopUpAlerts.DayOf(DateTimeOffset.UtcNow), null, ct);
                return Results.Unauthorized();
            }

            if (interp.MerchantTransactionId is null) return Results.BadRequest(new { error = "merchant_txn_missing" });
            var pending = await db.PendingTopups.FirstOrDefaultAsync(p => p.IdempotencyKey == interp.MerchantTransactionId, ct);
            if (pending is null) return Results.NotFound();

            // PayFast retries an ITN until it is acknowledged and the short-circuit below only
            // covers Completed, so a row that has already failed is re-judged on every retry.
            // The member must be told once, not once per retry.
            // M4-1: a row closed on our word (cancel return, expiry) is still open to the gateway.
            var wasPending = pending.Status == TopUpStatus.Pending || IsReopenable(pending);

            // Idempotent: PayFast retries an ITN until it is acknowledged, so a repeat is
            // the normal case rather than an attack. Answering 200 stops the retries.
            if (pending.Status == TopUpStatus.Completed)
                return Results.Ok(new { ok = true, idempotent = true });

            // D2-B04. EVERY terminal state is terminal, not just Completed.
            //
            // The short-circuit covered Completed alone, and the amount-mismatch path sets
            // Failed while KEEPING the original AmountZar and ConversionRate — so a later
            // signed COMPLETE for the same m_payment_id fell straight through to CompleteAsync
            // and credited at the originally-quoted figure, for a top-up the member had already
            // been emailed about as failed. R1 reported against a R1000 registration, refused,
            // and then 1600 credits issued for one rand. Cancelled had the same shape: a member
            // who deliberately backed out could be credited by a later notification.
            //
            // 200 rather than a 4xx, for the reason above it: PayFast retries until it is
            // acknowledged, and a club that answers 4xx for ever gets retried for ever. The
            // body says plainly which way the row settled.
            if (pending.Status is TopUpStatus.Failed or TopUpStatus.Cancelled && !IsReopenable(pending))
            {
                logger.LogInformation(
                    "topup {Key} is already settled as {Status}; a later notification does not re-open it",
                    pending.IdempotencyKey, pending.Status);
                return Results.Ok(new
                {
                    ok = false,
                    reason = "already_settled",
                    status = pending.Status.ToString(),
                    failure_code = pending.FailureReason,
                });
            }

            // The amount is signed, so this cannot be forged — but it CAN legitimately
            // differ from what was asked for, and a correctly-signed notification for R1
            // must not credit the member for the R1000 they requested. The signature proves
            // the message is authentic, not that it is the message expected.
            if (interp.AmountGross is not null && interp.AmountGross != pending.AmountZar)
            {
                logger.LogWarning(
                    "topup {Key}: PayFast reports {Reported} but the pending top-up is {Expected} — refusing",
                    pending.IdempotencyKey, interp.AmountGross, pending.AmountZar);

                pending.Status = TopUpStatus.Failed;
                pending.FailureReason = FailureCodes.AmountMismatch;
                await TopUpAlerts.StageAsync(db, tenantRow.Id, pending, ct);
                await db.SaveChangesAsync(ct);

                if (wasPending) await NotifyNotCompletedAsync(db, mailer, pending, ct);
                return Results.BadRequest(new { error = "amount_mismatch" });
            }

            if (interp.Successful)
            {
                // D2-B01. `ExternalReference: interp.PaymentId`, and PaymentId is
                // Field("pf_payment_id") — NULL when the field is missing. The unique index on
                // ExternalReference is filtered `WHERE "ExternalReference" IS NOT NULL`, so a
                // notification without that field carries no idempotency key at all and the
                // only guard on the money-in path silently disappears. The Completed
                // short-circuit above does not help: two deliveries racing each other both read
                // Pending, and both credit.
                //
                // Refused rather than credited-once, because there is nothing to make it
                // idempotent WITH. A refusal is visible — PayFast surfaces the failed ITN and
                // the pending row stays Pending, so a well-formed retry can still complete it —
                // and a double credit is not.
                //
                // Narrowed to the SUCCESSFUL branch deliberately. A cancellation or a decline
                // posts no ledger row and so needs no reference; refusing those for a missing
                // field would leave a member who backed out with a row stuck at Pending and no
                // email, which is a second bug in the name of fixing this one.
                if (string.IsNullOrWhiteSpace(interp.PaymentId))
                {
                    logger.LogWarning(
                        "topup {Key}: a COMPLETE notification arrived with no pf_payment_id — refusing, "
                        + "because nothing can make it idempotent", pending.IdempotencyKey);
                    await TopUpAlerts.RaiseAsync(db, tenantRow.Id, TopUpAlerts.PaymentIdMissing, pending.Id.ToString("N"), pending, ct);
                    return Results.BadRequest(new { error = "payment_id_missing" });
                }

                return await CompleteAsync(
                    new TopUpCompletion(db, ledger, settingsAccessor, emailService, bus, logger) { Club = club },
                    pending, tenantRow, interp, ct);
            }

            // PENDING is not a failure. PayFast sends one while an EFT clears, and marking
            // the row Failed on it meant a payment still in flight could never be completed
            // by the COMPLETE that follows — the idempotency check only short-circuits on
            // Completed, but the member had already been told it failed.
            if (string.Equals(interp.ResultCode, "PENDING", StringComparison.OrdinalIgnoreCase))
                return Results.Ok(new { ok = false, reason = "pending" });

            // CANCELLED is the member's own decision and is a distinct terminal state.
            // It was stored as Failed, so someone who deliberately backed out was told
            // their payment failed.
            var cancelled = string.Equals(interp.ResultCode, "CANCELLED", StringComparison.OrdinalIgnoreCase);
            pending.Status = cancelled ? TopUpStatus.Cancelled : TopUpStatus.Failed;
            pending.FailureReason = cancelled ? FailureCodes.Cancelled
                : string.Equals(interp.ResultCode, "FAILED", StringComparison.OrdinalIgnoreCase) ? FailureCodes.Declined
                : FailureCodes.GatewayError;
            pending.CompletedAt = DateTimeOffset.UtcNow;
            await TopUpAlerts.StageAsync(db, tenantRow.Id, pending, ct);
            await db.SaveChangesAsync(ct);

            if (wasPending) await NotifyNotCompletedAsync(db, mailer, pending, ct);
            return Results.Ok(new { ok = false, reason = pending.FailureReason });
        }).AllowAnonymous();

        return app;
    }

    /// <summary>
    /// Tells the member their top-up ended without credits — <c>feature-spec.md</c> §11.
    ///
    /// <para>
    /// This was the one terminal outcome of handing over card details that sent nothing.
    /// Confirmation was emailed, failure was not, so a member who closed the tab after
    /// PayFast could only learn what happened by finding the status page again — and the
    /// status page's own copy on the branch where it cannot reach the club promises this
    /// mail in as many words, which is exactly the branch where the mail is the only
    /// channel left. Cancellations get it too, because "either way" is what the screen says
    /// and a member who backed out still deserves to know nothing was taken.
    /// </para>
    ///
    /// <para>
    /// Dispatched in the background for the same reason the confirmation is: PayFast retries
    /// an ITN until it is acknowledged, so a slow SMTP handshake on this path becomes a
    /// duplicate notification. Callers gate it on the row having still been <c>Pending</c>,
    /// so a retried ITN on an already-failed row does not mail the member again.
    /// </para>
    /// </summary>
    private static async Task NotifyNotCompletedAsync(
        MainframeDbContext db, TopUpMailer mailer, PendingTopup pending, CancellationToken ct)
    {
        var recipient = await db.Users.AsNoTracking()
            .Where(u => u.Id == pending.UserId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(recipient)) return;

        // The club's own money symbol, resolved from the tenant the callback already set.
        // Never a constant: this mail names an amount the member's card was asked for.
        var symbol = CurrencySymbol.For(await mailer.Settings.GetAsync(ct));

        EmailDispatch.InBackground(
            mailer.Email, mailer.Logger,
            EmailTemplates.TopUpNotCompleted(
                await mailer.Club.GetAsync(ct), recipient, pending.AmountZar, pending.FailureReason,
                pending.ExternalReference ?? pending.IdempotencyKey, symbol),
            $"top-up failure notice for {pending.Id}");
    }

    /// <summary>
    /// What it takes to send one top-up mail. Bundled because the club and its settings are the
    /// fifth and sixth collaborators and the gate caps a signature at six.
    /// </summary>
    /// <remarks>
    /// <see cref="Settings"/> is here rather than passed alongside for the same reason the rest
    /// of it is: this mail states a rand figure, that figure wears the club's own symbol, and
    /// the club's symbol comes out of the same accessor the club's identity does. Widening the
    /// call signature instead would have put the method back over the gate.
    /// </remarks>
    private sealed record TopUpMailer(
        IEmailService Email, ILogger Logger, ClubIdentityResolver Club, TenantSettingsAccessor Settings);

    /// <summary>The services <see cref="CompleteAsync"/> needs, bundled so the method stays inside the argument gate.</summary>
    internal sealed record TopUpCompletion(
        MainframeDbContext Db,
        LedgerService Ledger,
        TenantSettingsAccessor Settings,
        IEmailService Email,
        IEventBus Bus,
        ILogger Logger)
    {
        /// <summary>
        /// Who the confirmation is from. Init-only rather than a seventh positional parameter:
        /// six is the gate, and the reason it exists still holds.
        /// </summary>
        public required ClubIdentityResolver Club { get; init; }
    }

    /// <summary>
    /// Converts a completed payment to credits and posts it.
    ///
    /// <para>
    /// The rate is <see cref="PendingTopup.ConversionRate"/> — what the member was quoted —
    /// falling back to the live tenant rate only for rows written before that column
    /// existed. Re-resolving it here is the defect this method exists to hold shut.
    /// </para>
    /// </summary>
    private static async Task<IResult> CompleteAsync(
        TopUpCompletion c, PendingTopup pending, Tenant tenantRow, CallbackInterpretation interp, CancellationToken ct)
    {
        pending.Status = TopUpStatus.Completed;
        pending.ExternalReference = interp.PaymentId;
        pending.CompletedAt = DateTimeOffset.UtcNow;
        // M4-1: a completion wins over a cancel return or an expiry, including one written by a
        // concurrent request after this row was read — so the reason is written unconditionally.
        pending.FailureReason = null;
        c.Db.Entry(pending).Property(p => p.FailureReason).IsModified = true;

        var settings = await c.Settings.GetAsync(ct);

        decimal rate;
        Guid? rateGroupId = pending.GroupId;
        if (pending.ConversionRate is { } quoted)
        {
            rate = quoted;
        }
        else
        {
            var live = await MemberTariffs.ForAsync(c.Db, pending.UserId, settings, ct);
            rate = live.TopUpRate;
            rateGroupId = live.RateGroup?.Id;
            c.Logger.LogInformation(
                "topup {Key} carries no quoted rate (pre-dates the column) — settling at the live rate {Rate}",
                pending.IdempotencyKey, rate);
        }

        // Rounded to the column, not by the column.
        //
        // ledger_entries.AmountCredits is numeric(10,2), so an unrounded product is
        // rounded on the way in regardless — but the HTTP response, the
        // credit.topped_up event and the ledger Reason string all quote the value
        // this variable holds, so they quoted a figure the database had not stored.
        // credits_per_zar_* accepts four decimals and admins bypass the block rule,
        // which is all it takes for the two to diverge. AwayFromZero matches
        // CreateWalkUpAsync and both penalty computations: the club does not round
        // in its own favour by accident.
        var credits = Convert(pending.AmountZar, rate);

        // D2-B02. The unique index on ledger_entries.ExternalReference carries no TenantId
        // while every READ of the table is scoped by the tenant query filter.
        // WalletEndpoints.IdempotencyReference prefixes a desk adjustment by hand precisely to
        // avoid that; the top-up path stored the bare PayFast id. Two clubs on one merchant
        // account — or any sandbox with small repeating ids — collide, and the second club's
        // post raises a unique violation which, with D2-B03's missing catch, was a 500, a
        // PendingTopup stuck at Pending, and a member never credited for money PayFast took.
        // Non-null by the caller's guard above, which is the whole of D2-B01. Asserted rather
        // than coalesced: a null here would mean the refusal had been removed, and silently
        // posting an unreferenced row is exactly the failure that guard exists to stop.
        var paymentId = interp.PaymentId
            ?? throw new InvalidOperationException(
                "a top-up reached CompleteAsync with no pf_payment_id; the D2-B01 guard has been removed");
        var reference = TopUpReference(tenantRow.Id, paymentId);

        try
        {
            await c.Ledger.PostAsync(new LedgerPosting(
                UserId: pending.UserId,
                Type: LedgerEntryType.TopUp,
                AmountCredits: credits,
                ZarPaid: pending.AmountZar,
                ConversionRate: rate,
                ActorUserId: pending.UserId,
                // Invariant separators, so the comment reads in the same convention as the
                // amount column beside it rather than the server's ambient culture.
                // The club's own money symbol, frozen into the row. A ledger reason is written
                // once and read for ever: a club that changes its symbol later has not changed
                // what this member paid, and re-rendering the history would be the lie.
                Reason: $"PayFast top-up ({EmailTemplates.Zar(pending.AmountZar, CurrencySymbol.For(settings))} → {EmailTemplates.Cr(credits)} @ {EmailTemplates.Num(rate)})",
                ExternalReference: reference), ct);

            await c.Db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsDuplicateReference(ex))
        {
            // D2-B03. This was the ONE PostAsync caller in the tree with no duplicate-reference
            // catch — WalletEndpoints, and three call sites in BookingService, all have one.
            // Two deliveries of the same payment in flight together cannot be separated by the
            // read-then-write short-circuit above: under READ COMMITTED neither can see the
            // other's uncommitted row, so the filtered unique index is what decides it, and the
            // loser escaped as a 500 that PayFast then retried into.
            return await AlreadyCreditedAsync(c, pending, interp, reference, ct);
        }

        var balanceAfter = await c.Ledger.GetBalanceAsync(pending.UserId, ct);

        // feature-spec.md §11 has required a top-up confirmation since it was written and
        // nothing sent one, so the single event where a member hands over real money was
        // the one event that produced no email. Dispatched in the background: PayFast
        // retries an ITN until it is acknowledged, so a slow SMTP handshake here becomes a
        // duplicate notification.
        var recipient = await c.Db.Users.AsNoTracking()
            .Where(u => u.Id == pending.UserId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (!string.IsNullOrEmpty(recipient))
        {
            EmailDispatch.InBackground(
                c.Email, c.Logger,
                EmailTemplates.TopUpConfirmation(
                    await c.Club.GetAsync(ct), recipient, new TopUpReceipt(
                        AmountZar: pending.AmountZar,
                        CreditsAdded: credits,
                        ConversionRate: rate,
                        BalanceAfterCredits: balanceAfter,
                        Reference: interp.PaymentId ?? pending.IdempotencyKey,
                        // The club's own symbol, for the one figure on this receipt that is
                        // money. The three credit figures beside it take none.
                        CurrencySymbol: CurrencySymbol.For(settings))),
                $"top-up confirmation for {pending.Id}");
        }

        await c.Bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "credit.topped_up",
            TenantId: tenantRow.Id, TenantSlug: tenantRow.Slug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: pending.UserId, ActorIsAdmin: false, SubjectUserId: pending.UserId,
            Data: new()
            {
                ["topup_id"] = pending.Id,
                ["zar_paid"] = pending.AmountZar,
                ["credits"] = credits,
                ["conversion_rate"] = rate,
                // D2: which group's rate was locked at checkout (null: the club default).
                ["rate_group_id"] = rateGroupId,
                ["groups"] = await GroupsWireAsync(c.Db, pending.UserId, ct),
                // Deprecated for one release: derived from the LOCKED group, so it says what the
                // column it replaced said — the tariff the member was quoted, not their class now.
                ["member_class"] = await LegacyClassOfGroupAsync(c.Db, rateGroupId, ct),
                ["external_reference"] = interp.PaymentId,
            }), ct);

        return Results.Ok(new { ok = true, credits, conversion_rate = rate });
    }

    /// <summary>
    /// The <c>ExternalReference</c> a PayFast payment id maps to.
    ///
    /// <para>
    /// The tenant is part of it for the reason <c>WalletEndpoints.IdempotencyReference</c>
    /// records at length: the unique index is global and every read of the table is
    /// tenant-filtered, so two clubs sending the same key collide in the index while each
    /// club's lookup for its "existing" row finds nothing. The <c>topup:</c> prefix keeps this
    /// namespace apart from <c>adjust:</c>, <c>walkup:</c> and the settlement references, all
    /// of which share one column.
    /// </para>
    /// </summary>
    internal static string TopUpReference(Guid tenantId, string paymentId)
        => $"{TopUpReferencePrefix}{tenantId:N}:{paymentId.Trim()}";

    /// <summary>The namespace a PayFast payment id lives in on <c>ledger_entries.ExternalReference</c>.</summary>
    internal const string TopUpReferencePrefix = "topup:";

    /// <summary>
    /// The two filtered unique indexes that can decide a duplicate payment, matched by name.
    ///
    /// <para>
    /// <b>Both, not one.</b> A completion writes two rows in one save — the ledger entry under
    /// <c>topup:{tenant}:{id}</c> and the pending row's own <c>ExternalReference</c>, which
    /// keeps the raw gateway id because it is what the member is asked to quote. So a second
    /// registration reporting an already-seen payment id is refused by the <i>pending</i> index,
    /// on a table the caller is not even thinking about, and matching only the ledger's name
    /// would let that escape as the 500 this catch exists to end.
    /// </para>
    /// </summary>
    private static readonly string[] DuplicateReferenceIndexes =
    [
        "IX_ledger_entries_ExternalReference",
        "IX_pending_topups_TenantId_ExternalReference",
    ];

    private static bool IsDuplicateReference(DbUpdateException ex)
        => ex.InnerException is Npgsql.PostgresException pg
           && pg.SqlState == "23505"
           && DuplicateReferenceIndexes.Contains(pg.ConstraintName);

    /// <summary>
    /// The answer when the index says this payment has already been credited.
    ///
    /// <para>
    /// <b>The pending row's own status is the discriminator, and it is re-read after the
    /// tracker is cleared.</b> There are exactly two ways to arrive here and they need
    /// different answers:
    /// </para>
    ///
    /// <list type="number">
    ///   <item>
    ///     <b>Two deliveries of ONE payment in flight together.</b> Both address the same
    ///     <c>m_payment_id</c> and therefore the same row, the winner has just committed it as
    ///     <c>Completed</c>, and the loser is a retry that has already been honoured — 200,
    ///     idempotent, which is what PayFast needs to stop retrying.
    ///   </item>
    ///   <item>
    ///     <b>A DIFFERENT registration reporting a payment id that is already spent.</b> The row
    ///     is still <c>Pending</c>, because nothing has completed it — and it has not been paid
    ///     for. Answering 200 would tell the member a second R100 had been credited when it had
    ///     not, so this is <c>409 payment_id_conflict</c>, which is the honest answer and the
    ///     one a person can act on.
    ///   </item>
    /// </list>
    ///
    /// <para>
    /// Either way the money is not posted twice, which is the part that matters; the status
    /// tells the two apart so the member is not lied to about which happened.
    /// </para>
    /// </summary>
    private static async Task<IResult> AlreadyCreditedAsync(
        TopUpCompletion c, PendingTopup pending, CallbackInterpretation interp, string reference, CancellationToken ct)
    {
        c.Db.ChangeTracker.Clear();

        var credited = await c.Db.LedgerEntries.AsNoTracking()
            .FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);
        var row = await c.Db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(p => p.Id == pending.Id, ct);

        if (row?.Status == TopUpStatus.Completed && credited is not null && credited.UserId == pending.UserId)
        {
            c.Logger.LogInformation(
                "topup {Key}: PayFast payment {PaymentId} was already credited by a concurrent delivery",
                pending.IdempotencyKey, interp.PaymentId);
            return Results.Ok(new { ok = true, idempotent = true });
        }

        c.Logger.LogError(
            "topup {Key}: PayFast payment {PaymentId} is already spent on another top-up in this club — refusing",
            pending.IdempotencyKey, interp.PaymentId);
        return Results.Json(
            new { error = "payment_id_conflict", topup_id = pending.Id },
            statusCode: StatusCodes.Status409Conflict);
    }

    /// <summary>
    /// How much rand this member has put into their account — settled, plus what is in flight.
    ///
    /// <para>
    /// <b>D2-B05.</b> <c>topup_max_zar_per_member</c> compared one <c>amountZar</c> against the
    /// setting and summed nothing, so blueprint A.3's R1000-per-member ceiling bounded a single
    /// transaction and a member could register ten of them. The key's own name says per member.
    /// </para>
    ///
    /// <para>
    /// <b>Pending rows count.</b> A member with four R1000 registrations open in four tabs has
    /// not paid yet but is one card form away from it, and counting only settled money is the
    /// same hole one round narrower. <c>Failed</c> and <c>Cancelled</c> do not count — a
    /// declined card is not money the member topped up, and charging their ceiling for it would
    /// lock them out of their own account.
    /// </para>
    ///
    /// <para>
    /// <b>Only a FRESH <c>Pending</c> counts</b> (M4-1): PayFast never reports a checkout the
    /// member abandoned, so an old Pending row is not money in flight and counting it locked the
    /// member out for good. See <see cref="PendingLifetime"/>.
    /// </para>
    /// </summary>
    private static async Task<decimal> ToppedUpZarAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var cutoff = PendingCutoff(DateTimeOffset.UtcNow);
        return await db.PendingTopups
            .Where(p => p.UserId == userId
                     && (p.Status == TopUpStatus.Completed
                         || (p.Status == TopUpStatus.Pending && p.CreatedAt >= cutoff)))
            .SumAsync(p => (decimal?)p.AmountZar, ct) ?? 0m;
    }

    /// <summary>
    /// The refusal for a member who has reached their ceiling, or null when they have not.
    ///
    /// <para>
    /// Every figure the sentence needs is in the body — the ceiling, what they have already put
    /// in, and what is left — so the screen never has to compose a number from two requests.
    /// Admins are exempt on the same terms they are exempt from the block rule: blueprint A.3
    /// says admin credit is unlimited, and this endpoint is the member-facing PayFast flow.
    /// </para>
    /// </summary>
    private static async Task<IResult?> RefuseCumulativeAsync(
        MainframeDbContext db, Guid userId, decimal amountZar, TenantSettingsView s, bool isAdmin, CancellationToken ct)
    {
        if (isAdmin) return null;

        var already = await ToppedUpZarAsync(db, userId, ct);
        var remaining = Math.Max(s.TopupMaxZarPerMember - already, 0m);
        if (amountZar <= remaining) return null;

        return Results.BadRequest(new
        {
            error = "amount_exceeds_member_cap",
            max_zar = s.TopupMaxZarPerMember,
            already_zar = already,
            remaining_zar = remaining,
        });
    }

    /// <summary>
    /// The refusal for a quote the club has moved away from, or null when the screen and the
    /// server still agree.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>/topup/options</c> is fetched once when the top-up screen mounts and never
    /// revalidated, and the screen promises the member the rate beside the figure "is locked
    /// in when you continue, so it can't change while you're paying". It was locked from the
    /// POST onward and not before it, so the half of the window the member actually looks at
    /// was unprotected: an admin changing that member's groups (their class, before D2), or editing
    /// a group's rate or <c>credits_per_zar_regular</c>, moved the price under an open tab and the
    /// member was handed to the gateway at the new one. Two independent testers reproduced it
    /// on the same day — R100 offered at 240 credits, settled at 160.
    /// </para>
    /// <para>
    /// The answer is a refusal rather than an honoured quote. The posted rate is a number the
    /// client chose, so obeying it would let anyone name their own price; comparing it costs
    /// the club nothing and keeps the promise, because the member either gets the figure they
    /// were shown or is stopped and shown the new one. 409, not 400: nothing about the request
    /// is malformed, the world moved.
    /// </para>
    /// <para>
    /// Exact equality is the right test. Both sides come from the same
    /// <c>MemberTariffs.Resolve</c> over the same numeric(8,4) values, so a rate that has not been
    /// edited round-trips identically through JSON; a tolerance here would silently accept
    /// exactly the small edits (1.6 → 1.5999) this exists to catch.
    /// </para>
    /// </remarks>
    internal static IResult? RefuseStaleQuote(decimal? quotedRate, decimal amountZar, MemberTariff tariff)
    {
        var liveRate = tariff.TopUpRate;
        if (quotedRate is null || quotedRate.Value == liveRate) return null;
        return Results.Json(new
        {
            error = "topup_rate_changed",
            conversion_rate = liveRate,
            quoted_credits = Convert(amountZar, liveRate),
            rate_group = RateGroupWire(tariff),
            // Deprecated for one release — see MemberTariff.LegacyMemberClass.
            member_class = tariff.LegacyMemberClass,
        }, statusCode: StatusCodes.Status409Conflict);
    }

    /// <summary>ZAR → credits at a given rate, rounded the way the column stores it.</summary>
    internal static decimal Convert(decimal amountZar, decimal rate)
        => Math.Round(amountZar * rate, 2, MidpointRounding.AwayFromZero);

    /// <summary>The group a rate came from, as the wire names it; null for the club's default rate.</summary>
    internal static object? RateGroupWire(MemberTariff tariff)
    {
        return tariff.RateGroup is { } g ? new { id = g.Id, name = g.Name, system_key = g.SystemKey } : null;
    }

    /// <summary>A member's active groups for an event payload: id, name and system key only.</summary>
    private static async Task<List<Dictionary<string, object?>>> GroupsWireAsync(
        MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        return (await MemberTariffs.GroupsOfAsync(db, userId, ct))
            .Select(g => new Dictionary<string, object?> { ["id"] = g.Id, ["name"] = g.Name, ["system_key"] = g.SystemKey })
            .ToList();
    }

    /// <summary>
    /// The deprecated <c>member_class</c> of a locked top-up: <c>LeagueOrSenior</c> when the
    /// locked rate group is the league system group, <c>Regular</c> otherwise. The tenant
    /// query filter applies, so an id that is not this club's reads as Regular.
    /// </summary>
    private static async Task<string> LegacyClassOfGroupAsync(MainframeDbContext db, Guid? groupId, CancellationToken ct)
    {
        if (groupId is not { } id) return MemberGroupSystemKeys.RegularClassName;
        var key = await db.MemberGroups.AsNoTracking().Where(g => g.Id == id).Select(g => g.SystemKey).FirstOrDefaultAsync(ct);
        return key == MemberGroupSystemKeys.League
            ? MemberGroupSystemKeys.LeagueClassName
            : MemberGroupSystemKeys.RegularClassName;
    }

    /// <summary>
    /// The refusal for an amount the club will not take, or null when it will.
    ///
    /// <para>
    /// Lifted out of the handler so the same three rules can be quoted to the screen by
    /// <c>/topup/options</c> and enforced here, rather than being written twice and
    /// drifting — which is exactly what happened.
    /// </para>
    /// </summary>
    internal static IResult? RefuseAmount(decimal amountZar, TenantSettingsView s, bool isAdmin)
    {
        if (amountZar <= 0)
            return Results.BadRequest(new { error = "amount_must_be_positive" });
        if (!isAdmin && s.TopupBlockZar > 0 && amountZar % s.TopupBlockZar != 0m)
            return Results.BadRequest(new { error = "amount_must_be_multiple_of_block", block_zar = s.TopupBlockZar });
        if (!isAdmin && amountZar > s.TopupMaxZarPerMember)
            return Results.BadRequest(new { error = "amount_exceeds_member_cap", max_zar = s.TopupMaxZarPerMember });
        return null;
    }

    /// <summary>
    /// The quick-pick amounts, derived from the tenant's own block and cap rather than
    /// hardcoded on the screen. 1×, 2×, 5× the block plus the cap itself, keeping only the
    /// ones the rules above would actually accept.
    /// </summary>
    internal static List<decimal> Presets(decimal blockZar, decimal maxZar)
    {
        if (blockZar <= 0) return [];
        var candidates = new List<decimal> { blockZar, blockZar * 2, blockZar * 5, maxZar };
        return candidates
            .Where(v => v > 0 && v <= maxZar && v % blockZar == 0m)
            .Distinct()
            .OrderBy(v => v)
            .ToList();
    }

    /// <summary>
    /// Parses <c>application/x-www-form-urlencoded</c> <b>preserving the order fields were
    /// sent in</b>, which is what PayFast signs over.
    ///
    /// <para>
    /// ASP.NET's <c>http.Form</c> is not usable here: it returns a sorted, de-duplicated
    /// dictionary. Ordering is invisible in every unit test that builds its own dictionary
    /// and fatal against the real gateway, which is the worst combination.
    /// </para>
    /// </summary>
    internal static List<KeyValuePair<string, string>> ParseFormPreservingOrder(string body)
    {
        var fields = new List<KeyValuePair<string, string>>();
        if (string.IsNullOrEmpty(body)) return fields;

        foreach (var pair in body.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            var key = eq < 0 ? pair : pair[..eq];
            var value = eq < 0 ? string.Empty : pair[(eq + 1)..];

            // '+' means space in a form body, and Uri.UnescapeDataString does not know that.
            fields.Add(new KeyValuePair<string, string>(
                Uri.UnescapeDataString(key.Replace('+', ' ')),
                Uri.UnescapeDataString(value.Replace('+', ' '))));
        }

        return fields;
    }

    // FailureCodes sits AFTER MapTopUpEndpoints, and where it sits changes what lizard calls
    // the map method: the C# parser scopes whatever FOLLOWS a nested class into that class, so
    // this order is reported as `TopUpEndpoints::MapTopUpEndpoints` and the other order as
    // `FailureCodes::MapTopUpEndpoints`. Both are the same function; only the label moves.
    //
    // THE PLACEMENT IS NO LONGER WHAT HOLDS THE GATE — whitelizard.txt does, by listing BOTH
    // names (see the note at the top of that file). It used to be load-bearing, and that is
    // exactly why it stopped being so: one round moved this class to make the single entry
    // match while another renamed the entry, each was green alone, and the merge was red on a
    // file nobody had edited. So move this class if you have a reason to; do NOT delete either
    // whitelizard line as redundant, because whichever one looks redundant is the one that
    // catches the next move. Verified 2026-09-06 by making that move in a scratch copy: the
    // reported name flipped to `FailureCodes::MapTopUpEndpoints` and `make complexity` stayed
    // green (exit 0) with both entries present.
    //
    // The underlying parser quirk is the one memory/gotchas.md records for expression-bodied
    // members whose bodies carry braces: what lizard reports is placement, not content.
    /// <summary>
    /// Stable, snake_case reasons a top-up did not complete.
    ///
    /// <para>
    /// These are stored on <c>pending_topups.FailureReason</c> and served to the client,
    /// which maps them to sentences. The column used to hold whatever string was nearest —
    /// <c>amount_mismatch:reported=100,00:expected=500,00</c> was rendered verbatim to a
    /// member as the explanation for a failed R500 payment, en-ZA comma decimals and all.
    /// The numbers behind a mismatch are in the log, where the person who needs them is.
    /// </para>
    /// </summary>
    public static class FailureCodes
    {
        /// <summary>PayFast reported an amount other than the one the top-up was registered for.</summary>
        public const string AmountMismatch = "amount_mismatch";

        /// <summary>The member backed out at the gateway. Not a failure, and must not be shown as one.</summary>
        public const string Cancelled = "cancelled";

        /// <summary>The gateway declined the payment — card refused, insufficient funds, 3DS abandoned.</summary>
        public const string Declined = "declined";

        /// <summary>The gateway answered with something this application does not recognise.</summary>
        public const string GatewayError = "gateway_error";

        /// <summary>The checkout could not be registered at all — usually missing merchant credentials.</summary>
        public const string ProviderRegisterFailed = "provider_register_failed";

        /// <summary>
        /// The member came back through the cancel URL (M4-1). Our word, not the gateway's, so a
        /// later signed COMPLETE still settles the row.
        /// </summary>
        public const string CancelledAtReturn = "cancelled_at_return";

        /// <summary>
        /// Nothing was heard for <see cref="PendingLifetime"/> (M4-1): an abandoned checkout.
        /// Reopenable like the cancel return.
        /// </summary>
        public const string Expired = "expired";
    }

}

/// <summary>
/// The amount a member wants to pay, in <b>rand</b>.
///
/// <para>
/// The client posted <c>amountCredits</c> against this record for as long as the screen
/// existed, so <c>AmountZar</c> bound to 0, the first guard fired, and no member could
/// ever top up — the screen told them the amount was wrong. The field is rand because
/// PayFast is paid in rand; the credits are what comes back.
/// </para>
/// </summary>
/// <param name="QuotedConversionRate">
/// The rate the member was looking at when they pressed Continue, as
/// <c>/topup/options</c> handed it to the screen.
///
/// <para>
/// It exists so the club cannot take money at a rate the member was never shown. The screen
/// says, in as many words, that the rate is locked in when you continue — and Continue
/// registered the <b>live</b> rate, so an admin changing the member's class or editing
/// <c>credits_per_zar_*</c> while the tab sat open sent a member who had been offered 240
/// credits for R100 to the gateway for 160. There is no confirmation step between Continue
/// and the card form, so nothing told her.
/// </para>
///
/// <para>
/// Honouring the posted number instead would let any client name its own price, so the
/// server compares rather than trusts: equal and the offer stands, different and the
/// request is refused with <c>topup_rate_changed</c> and the new figures, for the screen to
/// show before the member commits. Nullable, because a client that sends nothing — an
/// older build, or a script — gets the old behaviour rather than a 400.
/// </para>
/// </param>
public sealed record TopUpRequest(decimal AmountZar, decimal? QuotedConversionRate = null);
