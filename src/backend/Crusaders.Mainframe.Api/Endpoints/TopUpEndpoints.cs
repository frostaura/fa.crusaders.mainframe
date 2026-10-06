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
        // P13: a member buys PACKAGES (PackageEndpoints) and the club defines them
        // (AdminPackageEndpoints). Mapped from here so the one registration Program.cs makes for
        // the money-in path still brings all of it up. The old amount-based top-up routes are
        // gone with the cap and the conversion rate; only the ITN below keeps its path,
        // because PayFast holds it for every checkout already in flight.
        app.MapPackageEndpoints();
        app.MapAdminPackageEndpoints();

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
            // and then the whole purchase issued for one rand. Cancelled had the same shape: a member
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
    /// Tells the member their purchase ended without minutes — <c>feature-spec.md</c> §11.
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
            EmailTemplates.PurchaseNotCompleted(
                await mailer.Club.GetAsync(ct), recipient, new PackagePurchaseAttempt(
                    pending.PackageName, pending.Minutes, pending.AmountZar, pending.FailureReason,
                    pending.ExternalReference ?? pending.IdempotencyKey, symbol)),
            $"purchase failure notice for {pending.Id}");
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
    /// Posts a completed purchase: the LOCKED minutes on the purchase row (P13 §4.4, invariant 8).
    ///
    /// <para>
    /// Never the live package: an admin editing or archiving it while the member sat on PayFast's
    /// card page has not changed what money already paid buys, and re-reading it here is the
    /// defect this method exists to hold shut — the same one the conversion-rate lock held shut
    /// before minutes became the unit.
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

        var symbol = CurrencySymbol.For(await c.Settings.GetAsync(ct));

        // The LOCKED minutes on the purchase row, never a live package (P13 invariant 8).
        var minutes = pending.Minutes;

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
                AmountMinutes: minutes,
                ZarPaid: pending.AmountZar,
                ActorUserId: pending.UserId,
                // Invariant separators, so the comment reads in the same convention as the
                // amount column beside it rather than the server's ambient culture.
                // The club's own money symbol, frozen into the row. A ledger reason is written
                // once and read for ever: a club that changes its symbol later has not changed
                // what this member paid, and re-rendering the history would be the lie.
                Reason: PurchaseReason(pending, symbol),
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
            return await AlreadySettledAsync(c, pending, interp, reference, ct);
        }

        await AnnounceAsync(c, pending, tenantRow, paymentId, symbol, ct);
        return Results.Ok(new { ok = true, minutes, package_id = pending.PackageId });
    }

    /// <summary>
    /// The ledger reason a purchase is written with, once and read for ever:
    /// <c>PayFast purchase: 5 hours (5 hours) for R495.00</c>. Minutes in words, rand in the
    /// club's own symbol frozen into the row — a club that changes its symbol later has not changed
    /// what this member paid. Invariant separators, as everywhere money is written.
    /// </summary>
    internal static string PurchaseReason(PendingTopup pending, string symbol)
    {
        return $"PayFast purchase: {PackageWords(pending.PackageName, pending.Minutes)} for {EmailTemplates.Zar(pending.AmountZar, symbol)}";
    }

    /// <summary>
    /// The package as a ledger line names it: its name and, in brackets, its minutes — unless the
    /// name already IS its minutes ("5 hours", "5 h"), when the bracket only repeated it: the
    /// wallet read "5 hours (5 hours)" (review round 7, cosmetic). A name that says something
    /// else ("Club night") keeps its minutes beside it, because the name alone does not say them.
    /// </summary>
    internal static string PackageWords(string? packageName, int minutes)
    {
        var spoken = MoneyFormat.Minutes(minutes);
        var name = packageName?.Trim();
        if (string.IsNullOrEmpty(name)) return spoken;
        var sameThing = string.Equals(name, spoken, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(name, MoneyFormat.MinutesCompact(minutes), StringComparison.OrdinalIgnoreCase);
        return sameThing ? name : $"{name} ({spoken})";
    }

    /// <summary>
    /// The confirmation mail and the <c>minutes.purchased</c> event, after the money has posted.
    ///
    /// <para>
    /// The mail is dispatched in the background: PayFast retries an ITN until it is acknowledged,
    /// so a slow SMTP handshake here becomes a duplicate notification. It states the package, the
    /// minutes added, the list price, the discount when one applied, what was paid and the
    /// PayFast reference (P13 §6).
    /// </para>
    /// </summary>
    private static async Task AnnounceAsync(
        TopUpCompletion c, PendingTopup pending, Tenant tenantRow, string paymentId, string symbol, CancellationToken ct)
    {
        var balanceAfter = await c.Ledger.GetBalanceAsync(pending.UserId, ct);
        var discountGroupName = pending.GroupId is { } groupId
            ? await c.Db.MemberGroups.AsNoTracking().Where(g => g.Id == groupId).Select(g => g.Name).FirstOrDefaultAsync(ct)
            : null;

        var recipient = await c.Db.Users.AsNoTracking()
            .Where(u => u.Id == pending.UserId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (!string.IsNullOrEmpty(recipient))
        {
            EmailDispatch.InBackground(
                c.Email, c.Logger,
                EmailTemplates.PurchaseConfirmation(
                    await c.Club.GetAsync(ct), recipient, new PackagePurchaseReceipt(
                        PackageName: pending.PackageName,
                        Minutes: pending.Minutes,
                        ListPriceZar: pending.ListPriceZar,
                        DiscountBps: pending.DiscountBps,
                        DiscountGroupName: pending.DiscountBps > 0 ? discountGroupName : null,
                        AmountZar: pending.AmountZar,
                        BalanceAfterMinutes: balanceAfter,
                        Reference: paymentId,
                        CurrencySymbol: symbol)),
                $"purchase confirmation for {pending.Id}");
        }

        await c.Bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: MinutesEvents.Purchased,
            TenantId: tenantRow.Id, TenantSlug: tenantRow.Slug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: pending.UserId, ActorIsAdmin: false, SubjectUserId: pending.UserId,
            Data: PurchasedData(pending, await GroupsWireAsync(c.Db, pending.UserId, ct), paymentId)), ct);
    }

    /// <summary>The <c>minutes.purchased</c> payload (P13 §5), every figure from the locked row.</summary>
    internal static Dictionary<string, object?> PurchasedData(
        PendingTopup pending, List<Dictionary<string, object?>> groups, string paymentId)
    {
        return new Dictionary<string, object?>
        {
            ["purchase_id"] = pending.Id,
            ["package_id"] = pending.PackageId,
            ["package_name"] = pending.PackageName,
            ["minutes"] = pending.Minutes,
            ["list_price_zar"] = pending.ListPriceZar,
            ["discount_bps"] = pending.DiscountBps,
            ["zar_paid"] = pending.AmountZar,
            // The group whose discount was locked at checkout (null: none applied).
            ["discount_group_id"] = pending.GroupId,
            ["groups"] = groups,
            ["external_reference"] = paymentId,
        };
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
    private static async Task<IResult> AlreadySettledAsync(
        TopUpCompletion c, PendingTopup pending, CallbackInterpretation interp, string reference, CancellationToken ct)
    {
        c.Db.ChangeTracker.Clear();

        var posted = await c.Db.LedgerEntries.AsNoTracking()
            .FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);
        var row = await c.Db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(p => p.Id == pending.Id, ct);

        if (row?.Status == TopUpStatus.Completed && posted is not null && posted.UserId == pending.UserId)
        {
            c.Logger.LogInformation(
                "topup {Key}: PayFast payment {PaymentId} was already posted by a concurrent delivery",
                pending.IdempotencyKey, interp.PaymentId);
            return Results.Ok(new { ok = true, idempotent = true });
        }

        c.Logger.LogError(
            "topup {Key}: PayFast payment {PaymentId} is already spent on another top-up in this club — refusing",
            pending.IdempotencyKey, interp.PaymentId);
        return Results.Json(
            new { error = "payment_id_conflict", purchase_id = pending.Id },
            statusCode: StatusCodes.Status409Conflict);
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

        /// <summary>
        /// The club deleted the member while the checkout was open. Our word, so — like the two
        /// above — a signed COMPLETE that arrives later still credits the minutes: money that moved
        /// is on the ledger whatever happened to the account, and the club refunds it by hand.
        /// </summary>
        public const string MemberDeleted = "member_deleted";
    }

}
