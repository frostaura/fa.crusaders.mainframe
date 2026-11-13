using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Rand given back for a purchase (money lane BM-6): a refund the club made — cash, an EFT, a
/// refund on PayFast's own dashboard — or a card chargeback it recorded. Posted as ONE
/// <see cref="LedgerEntryType.PaymentReversal"/> naming the funding row it reverses, with the rand
/// negative and the minutes taken back (0 when the member keeps them), so Revenue (<c>reporting.md</c>:
/// top-ups net of reversals) finally nets what the club handed back.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a route of its own, not <c>refund_outside_system</c> on <c>/adjust</c>.</b> That code moves
/// minutes only and ignores rand, so the revenue report kept every refunded sale. A reversal names
/// the purchase, may give back at most the rand that purchase took and take back at most its minutes
/// (counted across every earlier reversal of it, under the member's payer lock), and carries the rand.
/// </para>
/// <para>
/// <b>Contract.</b> <c>GET /api/v1/admin/minutes/{userId}/reversible</c> lists the member's funding
/// rows that took rand, each with what is left to give back.
/// <c>POST /api/v1/admin/minutes/{userId}/reverse-payment</c> takes snake_case
/// <c>{entry_id, kind: refund|chargeback, zar_reversed, minutes_taken_back, reason, idempotency_key}</c>.
/// The balance may go below zero (a chargeback on minutes already played), as an adjustment's may.
/// The member is mailed; the change record files <c>credit.payment_reversed</c>.
/// </para>
/// </remarks>
public static partial class WalletEndpoints
{
    public const string ReversalRefund = "refund";
    public const string ReversalChargeback = "chargeback";

    /// <summary>The two kinds of rand given back.</summary>
    public static readonly string[] ReversalKinds = [ReversalRefund, ReversalChargeback];

    /// <summary>
    /// <c>GET /api/v1/admin/minutes/{userId}/reversible</c>: every funding row of the member's that
    /// took rand, newest first, with the rand and minutes still reversible. 404 for a member this
    /// club does not have (the tenant filter makes them not exist here).
    /// </summary>
    private static async Task<IResult> ReversibleAsync(Guid userId, MainframeDbContext db, CancellationToken ct)
    {
        if (!await db.Users.AnyAsync(u => u.Id == userId, ct)) return Results.NotFound();
        var funding = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == userId && LedgerEntryTypes.Funding.Contains(l.Type) && l.ZarPaid > 0m)
            .OrderByDescending(l => l.CreatedAt)
            .Take(200)
            .ToListAsync(ct);
        var ids = funding.Select(f => f.Id).ToList();
        var reversed = await ReversedSoFarAsync(db, ids, ct);
        return Results.Ok(new
        {
            entries = funding.Select(f =>
            {
                var (zar, minutes) = reversed.GetValueOrDefault(f.Id);
                return new
                {
                    entry_id = f.Id,
                    type = f.Type.ToString(),
                    created_at = f.CreatedAt,
                    reason = f.Reason,
                    zar_paid = f.ZarPaid,
                    amount_minutes = f.AmountMinutes,
                    zar_reversed = zar,
                    minutes_taken_back = minutes,
                    zar_left = f.ZarPaid!.Value - zar,
                    minutes_left = Math.Max(0, f.AmountMinutes - minutes),
                };
            }).ToList(),
        });
    }

    /// <summary>
    /// <c>POST /api/v1/admin/minutes/{userId}/reverse-payment</c>. Idempotent on the required key, in
    /// the desk's namespace: a replay of the same reversal answers what it posted, a changed one under
    /// the same key is <c>409 idempotency_key_reused</c>.
    /// </summary>
    private static async Task<IResult> ReversePaymentAsync(
        Guid userId, ReversePaymentRequest req, HttpContext ctx, [AsParameters] AdjustServices services, CancellationToken ct)
    {
        if (RefuseReversal(req) is { } refused) return refused;
        var reference = IdempotencyReference(services.Tenant.TenantId, req.IdempotencyKey);
        if (reference is not { Length: > 0 }) return Results.BadRequest(new { error = "idempotency_key_invalid" });

        var db = services.Db;
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return Results.NotFound();
        var original = await db.LedgerEntries.AsNoTracking().FirstOrDefaultAsync(l => l.Id == req.EntryId, ct);
        if (original is null || original.UserId != userId) return Results.NotFound(new { error = "entry_not_found" });
        if (!LedgerEntryTypes.Funding.Contains(original.Type) || original.ZarPaid is not > 0m)
            return Results.Json(new { error = "entry_not_reversible" }, statusCode: StatusCodes.Status409Conflict);

        var chargeback = req.Kind!.Trim() == ReversalChargeback;
        var zar = req.ZarReversed!.Value;
        var minutes = req.MinutesTakenBack!.Value;
        var symbol = CurrencySymbol.For(await services.Settings.GetAsync(ct));
        var movement = new DeskMovement(
            userId,
            new AdminCreditReasons.Kind(chargeback ? ReversalChargeback : ReversalRefund, LedgerEntryType.PaymentReversal),
            -minutes, -zar,
            $"{(chargeback ? "Chargeback" : "Refund")} of {Email.EmailTemplates.Zar(zar, symbol)} for {original.Reason ?? "a purchase"}",
            req.Reason!.Trim())
        {
            IdempotencyKey = req.IdempotencyKey,
            Reference = reference,
        };

        if (await ExistingAdjustmentAsync(db, reference, ct) is { } already)
            return ReversalReplay(already, movement, original, await ReplayBalancesAsync(services, already, ct), user);

        var outcome = await PostReversalAsync(movement, original, ctx, services, ct);
        if (outcome.Refusal is { } over) return over;
        if (outcome.Posted is not { } posted)
        {
            db.ChangeTracker.Clear();
            var twin = await ExistingAdjustmentAsync(db, reference, ct);
            if (twin is null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(outcome.Raced!);
            return ReversalReplay(twin!, movement, original, await ReplayBalancesAsync(services, twin!, ct), user);
        }

        await Email.EmailDispatch.QueueAsync(
            services.Email, services.LoggerFactory.CreateLogger("PaymentReversal"),
            Email.EmailTemplates.PaymentReversed(await services.Club.GetAsync(ct), user.Email, new Email.ReversedPayment(
                original.Reason ?? "your purchase", zar, minutes, posted.BalanceAfter, chargeback, symbol)),
            $"payment reversal {posted.Entry.Id}");

        return ReversalResult(posted.Entry, movement, original, (posted.BalanceBefore, posted.BalanceAfter), user, outcome.Left);
    }

    /// <summary>Everything that refuses a reversal before the database is read.</summary>
    private static IResult? RefuseReversal(ReversePaymentRequest req)
    {
        if (req.EntryId is null) return Results.BadRequest(new { error = "entry_id_required" });
        if (req.Kind is null || !ReversalKinds.Contains(req.Kind.Trim()))
            return Results.BadRequest(new { error = "kind_invalid", valid = ReversalKinds });
        if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
        if (string.IsNullOrWhiteSpace(req.IdempotencyKey)) return Results.BadRequest(new { error = "idempotency_key_required" });
        if (req.ZarReversed is not { } zar || zar <= 0m || zar > MaxZarReceived)
            return Results.BadRequest(new { error = "zar_reversed_out_of_range", max = MaxZarReceived });
        if (decimal.Round(zar, 2, MidpointRounding.AwayFromZero) != zar)
            return Results.BadRequest(new { error = "zar_reversed_not_whole_cents" });
        if (req.MinutesTakenBack is not { } minutes || minutes < 0 || minutes > MaxAdjustmentMinutes)
            return Results.BadRequest(new { error = "minutes_out_of_range", max_minutes = MaxAdjustmentMinutes });
        return null;
    }

    /// <summary>What has already been given back against each funding row: rand (positive) and minutes taken back (positive).</summary>
    private static async Task<Dictionary<Guid, (decimal Zar, int Minutes)>> ReversedSoFarAsync(
        MainframeDbContext db, IReadOnlyCollection<Guid> fundingIds, CancellationToken ct)
    {
        if (fundingIds.Count == 0) return [];
        var rows = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.Type == LedgerEntryType.PaymentReversal && l.ReversesEntryId != null && fundingIds.Contains(l.ReversesEntryId!.Value))
            .GroupBy(l => l.ReversesEntryId!.Value)
            .Select(g => new { Id = g.Key, Zar = g.Sum(x => x.ZarPaid ?? 0m), Minutes = g.Sum(x => x.AmountMinutes) })
            .ToListAsync(ct);
        return rows.ToDictionary(r => r.Id, r => (Math.Abs(r.Zar), -r.Minutes));
    }

    /// <summary>What a reversal leaves reversible on its purchase.</summary>
    private sealed record ReversalLeft(decimal Zar, int Minutes);

    private sealed record ReversalOutcome(AdjustmentPosted? Posted, DbUpdateException? Raced, IResult? Refusal, ReversalLeft? Left);

    /// <summary>
    /// The reversal, its audit row and its change record as one unit of work under the payer lock —
    /// <see cref="PostAndRecordAsync"/>'s shape, with the check that it does not give back more than
    /// the purchase took read INSIDE the lock, so two desks reversing one purchase at once cannot
    /// both fit under the limit.
    /// </summary>
    private static async Task<ReversalOutcome> PostReversalAsync(
        DeskMovement m, LedgerEntry original, HttpContext ctx, AdjustServices services, CancellationToken ct)
    {
        var (ledger, db) = (services.Ledger, services.Db);
        var actorId = ctx.User.Id() ?? Guid.Empty;
        await using var payerLock = await PayerLock.BeginAsync(db, services.Tenant.TenantId, m.UserId, services.Outbox, ct);

        var (zarBefore, minutesBefore) = (await ReversedSoFarAsync(db, [original.Id], ct)).GetValueOrDefault(original.Id);
        var zarLeft = original.ZarPaid!.Value - zarBefore;
        var minutesLeft = Math.Max(0, original.AmountMinutes - minutesBefore);
        if (-m.ZarPaid!.Value > zarLeft || -m.AmountMinutes > minutesLeft)
        {
            return new ReversalOutcome(null, null, Results.Json(
                new { error = "reversal_exceeds_payment", zar_left = zarLeft, minutes_left = minutesLeft },
                statusCode: StatusCodes.Status409Conflict), null);
        }

        var balanceBefore = await ledger.GetBalanceAsync(m.UserId, ct);
        LedgerEntry entry;
        try
        {
            entry = await ledger.PostAsync(new LedgerPosting(
                UserId: m.UserId, Type: LedgerEntryType.PaymentReversal, AmountMinutes: m.AmountMinutes, ActorUserId: actorId,
                Reason: m.LedgerReason, ExternalReference: m.Reference, ZarPaid: m.ZarPaid)
            {
                ReversesEntryId = original.Id,
            }, ct);
        }
        catch (DbUpdateException ex)
        {
            return new ReversalOutcome(null, ex, null, null);
        }

        var balanceAfter = await ledger.GetBalanceAsync(m.UserId, ct);
        db.AuditLogs.Add(DeskAudit(m, entry, (balanceBefore, balanceAfter), ctx));
        await services.Changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.PaymentReversed,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: m.UserId,
            SubjectLabel: PersonNames.Of(m.UserId, await PersonNames.ForAsync(db, [m.UserId], ct)),
            Reason: m.GivenReason,
            Before: new { balance_minutes = balanceBefore },
            After: new Dictionary<string, object?>
            {
                ["balance_minutes"] = balanceAfter,
                ["amount_minutes"] = m.AmountMinutes,
                ["kind"] = m.Kind.Code,
                ["zar_reversed"] = -m.ZarPaid!.Value,
                ["reverses_entry_id"] = original.Id,
                ["entry_id"] = entry.Id,
            }), ct);
        await db.SaveChangesAsync(ct);
        await payerLock.CommitAsync(ct);

        var left = new ReversalLeft(zarLeft + m.ZarPaid!.Value, minutesLeft + m.AmountMinutes);
        return new ReversalOutcome(new AdjustmentPosted(entry, balanceBefore, balanceAfter), null, null, left);
    }

    /// <summary>A key this club already applied: the same reversal replays, a different one is refused (the desk's rule).</summary>
    private static IResult ReversalReplay(
        LedgerEntry stored, DeskMovement m, LedgerEntry original, (int Before, int After) balance, Domain.User user)
    {
        var same = stored.UserId == m.UserId && stored.Type == LedgerEntryType.PaymentReversal
                   && stored.AmountMinutes == m.AmountMinutes && stored.ZarPaid == m.ZarPaid
                   && stored.ReversesEntryId == original.Id;
        if (!same)
        {
            return Results.Json(new
            {
                error = "idempotency_key_reused",
                stored = new { amount_minutes = stored.AmountMinutes, type = stored.Type.ToString(), reason = stored.Reason, at = stored.CreatedAt },
            }, statusCode: StatusCodes.Status409Conflict);
        }
        return ReversalResult(stored, m, original, balance, user, null);
    }

    private static IResult ReversalResult(
        LedgerEntry entry, DeskMovement m, LedgerEntry original, (int Before, int After) balance, Domain.User user, ReversalLeft? left)
    {
        return Results.Ok(new
        {
            entry_id = entry.Id,
            type = entry.Type.ToString(),
            kind = m.Kind.Code,
            amount_minutes = entry.AmountMinutes,
            zar_reversed = Math.Abs(entry.ZarPaid ?? 0m),
            reverses_entry_id = original.Id,
            zar_left = left?.Zar,
            minutes_left = left?.Minutes,
            balance_before_minutes = balance.Before,
            balance_after_minutes = balance.After,
            member = new { user_id = user.Id, email = user.Email },
        });
    }
}

/// <summary>
/// A reversal of a purchase's rand (money lane BM-6), snake_case on the wire. <c>MinutesTakenBack</c>
/// is how many of the purchase's minutes come off the balance with it (0 when the member keeps them).
/// </summary>
public sealed record ReversePaymentRequest(
    [property: JsonPropertyName("entry_id")] Guid? EntryId,
    [property: JsonPropertyName("kind")] string? Kind,
    [property: JsonPropertyName("zar_reversed")] decimal? ZarReversed,
    [property: JsonPropertyName("minutes_taken_back")] int? MinutesTakenBack,
    [property: JsonPropertyName("reason")] string? Reason,
    [property: JsonPropertyName("idempotency_key")] string? IdempotencyKey);
