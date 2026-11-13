using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Receiving a PayFast ITN — <c>docs/specs/payments-payfast.md</c>, "Receiving an ITN", in order.
/// </summary>
/// <remarks>
/// <para>
/// <b>What a notification must survive before money moves</b> (money lane BM-1, BP-01): a valid
/// signature over a passphrase the club must have; the club's own <c>merchant_id</c>; the source
/// check (advisory by default); an <c>amount_gross</c> that is present and equals the locked
/// price; and PayFast's own server confirming, through <c>/eng/query/validate</c>, that it sent
/// this notification. The last is asked only when the notification would change something, so a
/// retry of a settled payment costs no call.
/// </para>
/// <para>
/// <b>One checkout is credited once, by the database</b> (BM-2): the Pending→Completed move is a
/// conditional UPDATE under the member's payer lock, the ledger row carries the purchase id under
/// a unique index, and whoever loses either is told what actually happened. A second genuine
/// payment for an already-credited checkout is never answered "idempotent" (BM-3): it is raised to
/// the admins, mailed to the member, and acknowledged so PayFast stops retrying.
/// </para>
/// <para>
/// The purchase row is read <b>untracked</b> and every write to it is conditional, so a FAILED
/// or CANCELLED racing a COMPLETE can never overwrite the completion — an unconditional tracked
/// save used to be able to.
/// </para>
/// </remarks>
public static partial class TopUpEndpoints
{
    /// <summary>One ITN being judged, with what every step reads.</summary>
    private sealed record Itn(
        HttpContext Http,
        MainframeDbContext Db,
        Tenant TenantRow,
        PerTenantCredentials Creds,
        IReadOnlyList<KeyValuePair<string, string>> Fields,
        CallbackInterpretation Interp)
    {
        public ILogger Logger { get; } = Http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("TopUpCallback");

        public T Service<T>() where T : notnull => Http.RequestServices.GetRequiredService<T>();

        public string? Field(string name) => Fields
            .FirstOrDefault(f => string.Equals(f.Key, name, StringComparison.OrdinalIgnoreCase)).Value;
    }

    private static async Task<IResult> ReceiveItnAsync(HttpRequest http, CancellationToken ct)
    {
        var services = http.HttpContext.RequestServices;
        var db = services.GetRequiredService<MainframeDbContext>();
        var slug = http.Query["tenant"].ToString();
        if (string.IsNullOrEmpty(slug)) return Results.BadRequest(new { error = "tenant_missing" });

        var tenantRow = await db.Tenants.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Slug == slug, ct);
        if (tenantRow is null) return Results.NotFound();
        services.GetRequiredService<ITenantContext>().Set(tenantRow.Id, tenantRow.Slug);

        var creds = await services.GetRequiredService<TenantSecretsAccessor>().GetPaymentsAsync(ct);
        if (creds is null) return Results.Json(new { error = "payments_not_configured" }, statusCode: 503);

        string raw;
        using (var sr = new StreamReader(http.Body, Encoding.UTF8, leaveOpen: true)) raw = await sr.ReadToEndAsync(ct);

        // PayFast posts application/x-www-form-urlencoded and signs the fields IN THE ORDER SENT,
        // so the raw body is parsed positionally. http.Form would hand back a sorted dictionary
        // and every notification would fail to verify, with nothing in the log saying why.
        var fields = ParseFormPreservingOrder(raw);
        var interp = await services.GetRequiredService<IPaymentProvider>().InterpretCallbackAsync(
            new CallbackPayload(creds, raw, SignatureHeader: "", fields)
            {
                SourceIp = http.HttpContext.Connection.RemoteIpAddress?.ToString(),
            }, ct);

        var itn = new Itn(http.HttpContext, db, tenantRow, creds, fields, interp);
        if (await RefuseUntrustedAsync(itn, ct) is { } refused) return refused;

        if (interp.MerchantTransactionId is null) return Results.BadRequest(new { error = "merchant_txn_missing" });
        var pending = await db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(p => p.IdempotencyKey == interp.MerchantTransactionId, ct);
        if (pending is null) return Results.NotFound();

        return await JudgeAsync(itn, pending, ct);
    }

    /// <summary>Steps 1 and 2 plus the merchant: refusals that need no purchase row. Null when the ITN may be judged.</summary>
    private static async Task<IResult?> RefuseUntrustedAsync(Itn itn, CancellationToken ct)
    {
        var today = TopUpAlerts.DayOf(DateTimeOffset.UtcNow);
        if (!itn.Interp.SignatureValid)
        {
            itn.Logger.LogWarning("topup callback signature invalid for tenant {Slug}", itn.TenantRow.Slug);
            await TopUpAlerts.RaiseAsync(itn.Db, itn.TenantRow.Id, TopUpAlerts.SignatureInvalid, today, null, ct);
            return Results.Unauthorized();
        }

        // A signed notification for another merchant account is not this club's money, however it
        // came to be signed with this club's passphrase.
        if (!string.Equals(itn.Field("merchant_id")?.Trim(), itn.Creds.MerchantId, StringComparison.Ordinal))
        {
            itn.Logger.LogWarning("topup callback for tenant {Slug} names another merchant id — refusing", itn.TenantRow.Slug);
            await TopUpAlerts.RaiseAsync(itn.Db, itn.TenantRow.Id, TopUpAlerts.MerchantMismatch, today, null, ct);
            return Results.Json(new { error = TopUpAlerts.MerchantMismatch }, statusCode: StatusCodes.Status401Unauthorized);
        }

        var verdict = await itn.Service<PayFastSourceCheck>().JudgeAsync(itn.Http.Connection.RemoteIpAddress, ct);
        if (verdict is SourceVerdict.Unrecognised or SourceVerdict.Refused)
        {
            await TopUpAlerts.RaiseAsync(itn.Db, itn.TenantRow.Id, TopUpAlerts.SourceUnrecognised, today, null, ct);
        }
        return verdict == SourceVerdict.Refused
            ? Results.Json(new { error = TopUpAlerts.SourceUnrecognised }, statusCode: StatusCodes.Status403Forbidden)
            : null;
    }

    /// <summary>Steps 3 to 5 against the purchase the ITN names.</summary>
    private static async Task<IResult> JudgeAsync(Itn itn, PendingTopup pending, CancellationToken ct)
    {
        var interp = itn.Interp;
        if (pending.Status == TopUpStatus.Completed) return await AlreadyCompletedAsync(itn, pending, ct);
        if (pending.Status is TopUpStatus.Failed or TopUpStatus.Cancelled && !IsReopenable(pending)) return await AlreadyClosedAsync(itn, pending, ct);

        if (interp.Successful && await RefuseUnanchoredCompleteAsync(itn, pending, ct) is { } unanchored) return unanchored;

        var mismatch = interp.AmountGross is { } gross && gross != pending.AmountZar;

        // PENDING is not a failure: PayFast sends one while an EFT clears. Nothing changes, so
        // nothing needs confirming.
        if (!mismatch && string.Equals(interp.ResultCode, "PENDING", StringComparison.OrdinalIgnoreCase))
            return Results.Ok(new { ok = false, reason = "pending" });

        // Everything below writes; PayFast confirms it sent this before anything does.
        if (await ConfirmWithPayFastAsync(itn, ct) is { } unconfirmed) return unconfirmed;

        if (mismatch)
        {
            // The amount is signed, so this cannot be forged — but it CAN legitimately differ from
            // what was asked for, and a correctly signed notification for R1 must not credit the
            // R1000 package. A mismatch fails the row for good.
            itn.Logger.LogWarning(
                "topup {Key}: PayFast reports {Reported} but the purchase is locked at {Expected} — refusing",
                pending.IdempotencyKey, interp.AmountGross, pending.AmountZar);
            var settled = await CloseAsync(itn, pending, TopUpStatus.Failed, FailureCodes.AmountMismatch, ct);
            return settled ?? Results.BadRequest(new { error = "amount_mismatch" });
        }

        if (interp.Successful) return await CompleteAsync(itn, pending, ct);

        // CANCELLED is the member's own decision and a distinct terminal state; FAILED is the card.
        var cancelled = string.Equals(interp.ResultCode, "CANCELLED", StringComparison.OrdinalIgnoreCase);
        var reason = cancelled ? FailureCodes.Cancelled
            : string.Equals(interp.ResultCode, "FAILED", StringComparison.OrdinalIgnoreCase) ? FailureCodes.Declined
            : FailureCodes.GatewayError;
        return await CloseAsync(itn, pending, cancelled ? TopUpStatus.Cancelled : TopUpStatus.Failed, reason, ct)
               ?? Results.Ok(new { ok = false, reason });
    }

    /// <summary>
    /// A COMPLETE that has nothing to anchor it: no <c>pf_payment_id</c> (D2-B01 — nothing can make
    /// it idempotent) or no <c>amount_gross</c> (BM-1 — nothing to check the locked price against).
    /// Refused without touching the row, so a well-formed retry can still complete it.
    /// </summary>
    private static async Task<IResult?> RefuseUnanchoredCompleteAsync(Itn itn, PendingTopup pending, CancellationToken ct)
    {
        var (code, missing) = string.IsNullOrWhiteSpace(itn.Interp.PaymentId) ? (TopUpAlerts.PaymentIdMissing, "pf_payment_id")
            : itn.Interp.AmountGross is null ? (TopUpAlerts.AmountMissing, "amount_gross")
            : (null, null);
        if (code is null) return null;

        itn.Logger.LogWarning("topup {Key}: a COMPLETE notification arrived with no {Field} — refusing", pending.IdempotencyKey, missing);
        await TopUpAlerts.RaiseAsync(itn.Db, itn.TenantRow.Id, code, pending.Id.ToString("N"), pending, ct);
        return Results.BadRequest(new { error = code });
    }

    /// <summary>PayFast's validate call. Null when PayFast confirms; otherwise the refusal (401) or a 503 PayFast will retry into.</summary>
    private static async Task<IResult?> ConfirmWithPayFastAsync(Itn itn, CancellationToken ct)
    {
        var answer = await itn.Service<IPayFastItnValidator>().ValidateAsync(itn.Fields, itn.Creds, ct);
        if (answer == ItnValidation.Valid) return null;
        if (answer == ItnValidation.Unavailable)
            return Results.Json(new { error = "payfast_unreachable" }, statusCode: StatusCodes.Status503ServiceUnavailable);

        itn.Logger.LogWarning("topup callback for tenant {Slug} was not confirmed by PayFast — refusing", itn.TenantRow.Slug);
        await TopUpAlerts.RaiseAsync(itn.Db, itn.TenantRow.Id, TopUpAlerts.ValidationFailed, TopUpAlerts.DayOf(DateTimeOffset.UtcNow), null, ct);
        return Results.Json(new { error = TopUpAlerts.ValidationFailed }, statusCode: StatusCodes.Status401Unauthorized);
    }

    /// <summary>
    /// A notification for a purchase already credited. A retry of the payment that credited it is
    /// idempotent (200 stops PayFast retrying); a COMPLETE carrying a DIFFERENT payment id is a
    /// second real payment, which is confirmed with PayFast and then flagged, never swallowed.
    /// </summary>
    private static async Task<IResult> AlreadyCompletedAsync(Itn itn, PendingTopup pending, CancellationToken ct)
    {
        if (!IsAnotherPayment(itn.Interp, pending.ExternalReference)) return Results.Ok(new { ok = true, idempotent = true });
        if (await ConfirmWithPayFastAsync(itn, ct) is { } unconfirmed) return unconfirmed;
        return await FlagUncreditedAsync(itn, pending, TopUpAlerts.PaidTwice, ct);
    }

    /// <summary>
    /// D2-B04: a purchase the gateway closed stays closed — a later COMPLETE never credits it. But a
    /// genuine COMPLETE means money moved, so it is confirmed and flagged for the desk. The one
    /// exception is a retry of the very notification that failed the row on its amount: that was
    /// raised when it happened.
    /// </summary>
    private static async Task<IResult> AlreadyClosedAsync(Itn itn, PendingTopup pending, CancellationToken ct)
    {
        itn.Logger.LogInformation(
            "topup {Key} is already settled as {Status}; a later notification does not re-open it", pending.IdempotencyKey, pending.Status);
        var settled = Results.Ok(new
        {
            ok = false,
            reason = "already_settled",
            status = pending.Status.ToString(),
            failure_code = pending.FailureReason,
        });

        var paidLater = itn.Interp.Successful && !string.IsNullOrWhiteSpace(itn.Interp.PaymentId)
                        && pending.FailureReason != FailureCodes.AmountMismatch;
        if (!paidLater) return settled;
        if (await ConfirmWithPayFastAsync(itn, ct) is { } unconfirmed) return unconfirmed;
        await FlagUncreditedAsync(itn, pending, TopUpAlerts.PaidAfterClose, ct);
        return settled;
    }

    private static bool IsAnotherPayment(CallbackInterpretation interp, string? creditedPaymentId) =>
        interp.Successful
        && !string.IsNullOrWhiteSpace(interp.PaymentId)
        && !string.Equals(interp.PaymentId.Trim(), creditedPaymentId?.Trim(), StringComparison.Ordinal);

    /// <summary>
    /// A payment PayFast took that this checkout cannot credit: raised to the admins once per
    /// PayFast id, mailed to the member once (the notice's dedupe decides both), acknowledged 200.
    /// </summary>
    private static async Task<IResult> FlagUncreditedAsync(Itn itn, PendingTopup pending, string reason, CancellationToken ct)
    {
        var paymentId = itn.Interp.PaymentId!.Trim();
        itn.Logger.LogError(
            "topup {Key}: PayFast payment {PaymentId} ({Reason}) was received and NOT credited — raised for the desk",
            pending.IdempotencyKey, paymentId, reason);

        var key = $"{AdminEventCatalogue.TopUpFailed}:{reason}:{paymentId}";
        var raisedBefore = await itn.Db.AdminNotifications.AsNoTracking().AnyAsync(n => n.DedupeKey == key, ct);
        await TopUpAlerts.RaiseUncreditedAsync(itn.Db, itn.TenantRow.Id, reason, paymentId, itn.Interp.AmountGross, pending, ct);
        if (!raisedBefore) await MailUncreditedAsync(itn, pending, reason == TopUpAlerts.PaidTwice, paymentId, ct);

        return Results.Ok(new { ok = false, reason, purchase_id = pending.Id });
    }

    private static async Task MailUncreditedAsync(Itn itn, PendingTopup pending, bool alreadyCredited, string paymentId, CancellationToken ct)
    {
        var recipient = await itn.Db.Users.AsNoTracking().Where(u => u.Id == pending.UserId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(recipient)) return;
        var symbol = CurrencySymbol.For(await itn.Service<TenantSettingsAccessor>().GetAsync(ct));
        await EmailDispatch.QueueAsync(
            itn.Service<IEmailService>(), itn.Logger,
            EmailTemplates.PaymentNotCredited(await itn.Service<ClubIdentityResolver>().GetAsync(ct), recipient,
                new UncreditedPayment(pending.PackageName, itn.Interp.AmountGross, paymentId, alreadyCredited, symbol)),
            $"uncredited payment notice for {pending.Id}");
    }

    /// <summary>
    /// Settles an open purchase as not completed, conditionally: only a row still Pending (or closed
    /// on our own word) moves, so a completion that won a race is never overwritten. Null when this
    /// call moved it; otherwise the answer for the row as somebody else settled it.
    /// </summary>
    private static async Task<IResult?> CloseAsync(Itn itn, PendingTopup pending, TopUpStatus status, string reason, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var moved = await OpenRow(itn.Db, pending.Id).ExecuteUpdateAsync(u => u
            .SetProperty(p => p.Status, status)
            .SetProperty(p => p.FailureReason, reason)
            .SetProperty(p => p.CompletedAt, now), ct);
        if (moved == 0) return await AnswerForSettledAsync(itn, pending, ct);

        var closed = Closed(pending, status, reason, now);
        await TopUpAlerts.StageAsync(itn.Db, itn.TenantRow.Id, closed, ct);
        await itn.Db.SaveChangesAsync(ct);
        await NotifyNotCompletedAsync(itn.Db, Mailer(itn), closed, ct);
        return null;
    }

    private static PendingTopup Closed(PendingTopup p, TopUpStatus status, string reason, DateTimeOffset at) => new()
    {
        Id = p.Id, TenantId = p.TenantId, UserId = p.UserId, AmountZar = p.AmountZar, PackageId = p.PackageId,
        PackageName = p.PackageName, Minutes = p.Minutes, ListPriceZar = p.ListPriceZar, DiscountBps = p.DiscountBps,
        GroupId = p.GroupId, IdempotencyKey = p.IdempotencyKey, GatewayCheckoutId = p.GatewayCheckoutId,
        ExternalReference = p.ExternalReference, Status = status, FailureReason = reason, CreatedAt = p.CreatedAt, CompletedAt = at,
    };

    /// <summary>The purchase row while it is still open to the gateway: Pending, or closed on our word (M4-1).</summary>
    private static IQueryable<PendingTopup> OpenRow(MainframeDbContext db, Guid id) =>
        db.PendingTopups.Where(p => p.Id == id
            && (p.Status == TopUpStatus.Pending
                || (p.Status == TopUpStatus.Cancelled
                    && (p.FailureReason == FailureCodes.CancelledAtReturn
                        || p.FailureReason == FailureCodes.Expired
                        || p.FailureReason == FailureCodes.MemberDeleted))));

    /// <summary>Re-reads a row another request settled first and answers for it as it now stands.</summary>
    private static async Task<IResult> AnswerForSettledAsync(Itn itn, PendingTopup pending, CancellationToken ct)
    {
        var now = await itn.Db.PendingTopups.AsNoTracking().FirstAsync(p => p.Id == pending.Id, ct);
        if (now.Status != TopUpStatus.Completed) return await AlreadyClosedAsync(itn, now, ct);
        return IsAnotherPayment(itn.Interp, now.ExternalReference)
            ? await FlagUncreditedAsync(itn, now, TopUpAlerts.PaidTwice, ct)
            : Results.Ok(new { ok = true, idempotent = true });
    }

    private static TopUpMailer Mailer(Itn itn) => new(
        itn.Service<IEmailService>(), itn.Logger, itn.Service<ClubIdentityResolver>(), itn.Service<TenantSettingsAccessor>());

    /// <summary>
    /// Posts a completed purchase: the LOCKED minutes on the purchase row (P13 §4.4), never the live
    /// package — an admin editing or archiving it while the member sat on PayFast's card page has
    /// not changed what money already paid buys.
    /// </summary>
    private static async Task<IResult> CompleteAsync(Itn itn, PendingTopup pending, CancellationToken ct)
    {
        var paymentId = itn.Interp.PaymentId!;
        var outcome = await ClaimAndPostAsync(itn, pending, paymentId, ct);
        if (outcome is not null) return outcome;

        var completion = new TopUpCompletion(
            itn.Db, itn.Service<LedgerService>(), itn.Service<TenantSettingsAccessor>(), itn.Service<IEmailService>(),
            itn.Service<IEventBus>(), itn.Logger) { Club = itn.Service<ClubIdentityResolver>() };
        var symbol = CurrencySymbol.For(await completion.Settings.GetAsync(ct));
        await AnnounceAsync(completion, pending, itn.TenantRow, paymentId, symbol, ct);
        return Results.Ok(new { ok = true, minutes = pending.Minutes, package_id = pending.PackageId });
    }

    /// <summary>
    /// The money-moving unit, under the member's payer lock: claim the row (conditional UPDATE),
    /// post the ledger row naming the purchase, commit. Null when this request credited the
    /// purchase; otherwise the answer for whoever got there first.
    /// </summary>
    private static async Task<IResult?> ClaimAndPostAsync(Itn itn, PendingTopup pending, string paymentId, CancellationToken ct)
    {
        var db = itn.Db;
        var reference = TopUpReference(itn.TenantRow.Id, paymentId);
        var lost = false;
        try
        {
            await using var guard = await PayerLock.BeginAsync(db, itn.TenantRow.Id, pending.UserId, itn.Service<RealtimeOutbox>(), ct);
            var now = DateTimeOffset.UtcNow;
            var claimed = await OpenRow(db, pending.Id).ExecuteUpdateAsync(u => u
                .SetProperty(p => p.Status, TopUpStatus.Completed)
                .SetProperty(p => p.ExternalReference, paymentId)
                .SetProperty(p => p.CompletedAt, now)
                .SetProperty(p => p.FailureReason, (string?)null), ct);
            lost = claimed == 0;
            if (!lost)
            {
                var symbol = CurrencySymbol.For(await itn.Service<TenantSettingsAccessor>().GetAsync(ct));
                await itn.Service<LedgerService>().PostAsync(new LedgerPosting(
                    UserId: pending.UserId,
                    Type: LedgerEntryType.TopUp,
                    AmountMinutes: pending.Minutes,
                    ZarPaid: pending.AmountZar,
                    ActorUserId: pending.UserId,
                    Reason: PurchaseReason(pending, symbol),
                    ExternalReference: reference)
                {
                    PurchaseId = pending.Id,
                }, ct);
                await guard.CommitAsync(ct);
            }
        }
        catch (Exception ex) when (IsDuplicateReference(ex))
        {
            // The pending index (this payment id is already another purchase's) or the ledger's
            // (reference or purchase already posted). The transaction is gone; say which happened.
            db.ChangeTracker.Clear();
            return await AlreadyPostedAsync(itn, pending, reference, ct);
        }

        return lost ? await AnswerForSettledAsync(itn, pending, ct) : null;
    }

    /// <summary>
    /// The three filtered unique indexes that can decide a duplicate payment, matched by name: the
    /// ledger's reference, the ledger's one-credit-per-purchase, and the purchase table's one
    /// purchase per PayFast payment id.
    /// </summary>
    private static readonly string[] DuplicateReferenceIndexes =
    [
        "IX_ledger_entries_ExternalReference",
        "IX_ledger_entries_TenantId_PurchaseId",
        "IX_pending_topups_TenantId_ExternalReference",
    ];

    /// <summary>A unique violation on one of those indexes, whether EF wrapped it (a save) or not (a bulk UPDATE).</summary>
    private static bool IsDuplicateReference(Exception ex)
    {
        var pg = ex as Npgsql.PostgresException ?? ex.InnerException as Npgsql.PostgresException;
        return pg is { SqlState: "23505" } && DuplicateReferenceIndexes.Contains(pg.ConstraintName);
    }

    /// <summary>
    /// The answer when an index says this payment or this purchase is already spent. A row now
    /// Completed by this very payment is a concurrent delivery already honoured (200, idempotent);
    /// a row Completed by ANOTHER payment is a second payment (flagged); a row still open is a
    /// different purchase reporting a payment id another purchase spent — 409, the honest answer.
    /// </summary>
    private static async Task<IResult> AlreadyPostedAsync(Itn itn, PendingTopup pending, string reference, CancellationToken ct)
    {
        var row = await itn.Db.PendingTopups.AsNoTracking().FirstAsync(p => p.Id == pending.Id, ct);
        if (row.Status == TopUpStatus.Completed) return await AnswerForSettledAsync(itn, pending, ct);

        itn.Logger.LogError(
            "topup {Key}: PayFast payment {Reference} is already spent on another purchase in this club — refusing",
            pending.IdempotencyKey, reference);
        return Results.Json(new { error = "payment_id_conflict", purchase_id = pending.Id }, statusCode: StatusCodes.Status409Conflict);
    }
}
