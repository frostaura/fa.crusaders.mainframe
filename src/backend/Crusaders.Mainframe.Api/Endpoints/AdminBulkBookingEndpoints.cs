using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// GOAL items 5 and 13 — "multi-select bookings and delete them with ease and elegance", and
/// "multi select and book… as themselves or on behalf of".
///
/// <para>
/// <b>Both routes carry the <c>auth</c> rate limiter, and they are the first booking routes to
/// carry any.</b> The three existing booking groups attach none, so they are bounded only by
/// the global six-hundred-per-minute per-IP bucket shared with every other route. A bulk route
/// is an amplification factor of up to <c>admin_bulk_max_items</c> payer locks and GiST index
/// writes per request, which is not something to leave to a bucket that was sized for page
/// loads.
/// </para>
/// </summary>
/// <summary>
/// Everything a bulk handler resolves from the container, bound as one parameter.
///
/// <para>
/// The complexity gate caps a signature at six arguments (<c>lizard -a 6</c>), and a bulk
/// write genuinely needs the context, the settings, the service, the recorder, the db and the
/// ledger alongside its body and its token. <c>[AsParameters]</c> is the framework's own
/// answer; resolving out of <c>HttpContext.RequestServices</c> by hand would hide the
/// dependencies from the DI graph instead.
/// </para>
/// </summary>
public sealed record BulkDeps(
    AdminBulkBookingService Bulk,
    TenantSettingsAccessor Settings,
    AdminChangeRecorder Recorder,
    MainframeDbContext Db,
    LedgerService Ledger);

public static class AdminBulkBookingEndpoints
{
    public static IEndpointRouteBuilder MapAdminBulkBookingEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/bookings")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .RequireRateLimiting(RateLimitPolicies.Auth);

        g.MapPost("/bulk-cancel", CancelAsync);
        g.MapPost("/bulk", BookAsync);

        return app;
    }

    // ------------------------------------------------------------------ cancel

    private static async Task<IResult> CancelAsync(
        BulkCancelRequest req, HttpContext ctx, [AsParameters] BulkDeps deps, CancellationToken ct)
    {
        var (bulk, recorder, db) = (deps.Bulk, deps.Recorder, deps.Db);
        var view = await deps.Settings.GetAsync(ct);
        var items = req.Items ?? [];

        if (Validate(req.IdempotencyKey, items.Count, BulkSettings.MaxItems(view)) is { } bad)
        {
            return bad;
        }

        var reason = req.Reason?.Trim();
        if (string.IsNullOrEmpty(reason)) return Results.BadRequest(new { error = "reason_required" });
        if (reason.Length > BulkSettings.MaxReasonLength)
            return Results.BadRequest(new { error = "reason_too_long" });

        // A list naming one booking twice is a console bug, and silently collapsing it hides
        // the bug while making the counts in the answer disagree with the list the admin sent.
        var duplicate = items.GroupBy(i => i.BookingId).FirstOrDefault(grp => grp.Count() > 1);
        if (duplicate is not null)
            return Results.BadRequest(new { error = "duplicate_item", booking_id = duplicate.Key });

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var outcome = await bulk.CancelAsync(
            items.Select(i => new BulkCancelItem(i.BookingId, i.WaivePenalty)).ToList(),
            req.IdempotencyKey!.Trim(), reason, req.WaivePenalty, actorId, ct);

        var succeeded = outcome.Results.Count(r => r.Succeeded);

        // ONE row per BATCH, not per item. The batch row is the INTENT — the admin's own words
        // about why a list of courts went away — and CancelAsync's per-booking audit_log rows
        // are the EFFECTS, which the night trace reads. Recording the intent per item would
        // store the same sentence forty times and still not say that they were one decision.
        await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingsBulkCancelled,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.Booking,
            Reason: reason,
            After: new
            {
                requested = outcome.Results.Count,
                succeeded,
                failed = outcome.Results.Count - succeeded,
                total_refunded_credits = outcome.TotalRefundedCredits,
                total_penalty_credits = outcome.TotalPenaltyCredits,
                booking_ids = outcome.Results.Select(r => r.BookingId).ToList(),
            }), ct);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new
        {
            requested = outcome.Results.Count,
            succeeded,
            failed = outcome.Results.Count - succeeded,
            total_refunded_credits = outcome.TotalRefundedCredits,
            total_penalty_credits = outcome.TotalPenaltyCredits,
            results = outcome.Results.Select(r => new
            {
                booking_id = r.BookingId,
                status = r.Status,
                refund_credits = r.RefundCredits,
                penalty_credits = r.PenaltyCredits,
                member_name = r.MemberName,
                court_name = r.CourtName,
                starts_at = r.StartsAt,
                error = r.Error,
            }).ToList(),
        });
    }

    // ------------------------------------------------------------------ book

    private static async Task<IResult> BookAsync(
        BulkBookRequest req, HttpContext ctx, [AsParameters] BulkDeps deps, CancellationToken ct)
    {
        var (bulk, recorder, db, ledger) = (deps.Bulk, deps.Recorder, deps.Db, deps.Ledger);
        var view = await deps.Settings.GetAsync(ct);
        var items = req.Items ?? [];

        if (Validate(req.IdempotencyKey, items.Count, BulkSettings.MaxItems(view)) is { } bad)
        {
            return bad;
        }

        var actorId = ctx.User.Id() ?? Guid.Empty;

        var (context, refusal) = await ResolveOnBehalfAsync(req, actorId, db, ct);
        if (refusal is not null) return refusal;

        // The payer as they were before the batch, read once. An admin needs the pair to
        // explain a top-up to the member standing in front of them, and re-reading it per item
        // would report the balance after the last booking as the balance before the first.
        var before = context.PayerUserId is { } payer ? await ledger.GetBalanceAsync(payer, ct) : (decimal?)null;

        var outcome = await bulk.BookAsync(
            items.Select(i => new BulkBookItem(i.CourtId, i.StartsAt, i.SliceCount)).ToList(),
            context, actorId, ct);

        var after = context.PayerUserId is { } payerAfter ? await ledger.GetBalanceAsync(payerAfter, ct) : (decimal?)null;
        var succeeded = outcome.Results.Count(r => r.Succeeded);

        await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingsBulkBooked,
            ActorUserId: actorId,
            SubjectKind: context.PayerUserId is null ? AdminChangeSubjects.Booking : AdminChangeSubjects.User,
            SubjectId: context.PayerUserId,
            SubjectLabel: context.GuestName,
            Reason: req.Note?.Trim(),
            After: new
            {
                requested = outcome.Results.Count,
                succeeded,
                failed = outcome.Results.Count - succeeded,
                total_charged_credits = outcome.TotalChargedCredits,
                booking_ids = outcome.Results.Where(r => r.BookingId is not null)
                    .Select(r => r.BookingId!.Value).ToList(),
            }), ct);
        await db.SaveChangesAsync(ct);

        var payerName = context.PayerUserId is { } id
            ? PersonNames.Of(id, await PersonNames.ForAsync(db, [id], ct))
            : null;

        return Results.Ok(new
        {
            requested = outcome.Results.Count,
            succeeded,
            failed = outcome.Results.Count - succeeded,
            total_charged_credits = outcome.TotalChargedCredits,
            payer = context.PayerUserId is null
                ? null
                : (object)new
                {
                    user_id = context.PayerUserId,
                    name = payerName,
                    balance_before_credits = before,
                    balance_after_credits = after,
                },
            // Present only when the batch stopped early, so a console can tell "these eight
            // are the whole answer" from "these five are as far as we got".
            halted_at = outcome.HaltedAt,
            halted_reason = outcome.HaltedReason,
            results = outcome.Results.Select(r => new
            {
                index = r.Index,
                status = r.Status,
                booking_id = r.BookingId,
                court_name = r.CourtName,
                starts_at = r.StartsAt,
                ends_at = r.EndsAt,
                amount_credits = r.AmountCredits,
                error = r.Error,
            }).ToList(),
        });
    }

    /// <summary>
    /// Which of the four <c>on_behalf</c> shapes this is, or the refusal.
    ///
    /// <para>
    /// Block body for the lizard reason in <c>memory/gotchas.md</c> — the four shapes are four
    /// different rows in the database and collapsing the branch would lose which one.
    /// </para>
    /// </summary>
    private static async Task<(BulkBookRequestContext Context, IResult? Refusal)> ResolveOnBehalfAsync(
        BulkBookRequest req, Guid actorId, MainframeDbContext db, CancellationToken ct)
    {
        var guest = req.OnBehalf?.GuestName?.Trim();
        var userId = req.OnBehalf?.UserId;
        var key = req.IdempotencyKey!.Trim();

        if (guest is not null && (guest.Length == 0 || guest.Length > BulkSettings.MaxGuestNameLength))
        {
            return (default, Results.BadRequest(new { error = "guest_name_invalid" }));
        }

        var note = req.Note?.Trim();
        if (note is { Length: > BulkSettings.MaxNoteLength })
        {
            return (default, Results.BadRequest(new { error = "note_too_long" }));
        }

        // Omitted entirely means the admin's own booking on their own wallet. That is a real
        // shape, not an oversight, and refusing it would make an admin booking their own court
        // use a different route from the one they are already on.
        //
        // The ACTOR becomes the payer here, and that is load-bearing: a null payer means "a
        // free-text guest", which the service writes as a block charging nobody. Leaving it
        // null for this shape made an admin booking their own court produce an unpaid admin
        // block in their own name — caught by
        // Omitting_on_behalf_books_the_admins_own_court_on_their_own_wallet, which read
        // "blocked" where it wanted "booked".
        if (userId is null && guest is null)
        {
            return (new BulkBookRequestContext(actorId, null, null, req.AllowNegativeBalance, key), null);
        }

        if (userId is null)
        {
            // A guest with no member behind them. No wallet, no email, no cancellation rights —
            // an admin block that charges nobody, labelled with the name the admin typed.
            return (new BulkBookRequestContext(null, guest, null, req.AllowNegativeBalance, key), null);
        }

        var exists = await db.Users.AsNoTracking().AnyAsync(u => u.Id == userId.Value, ct);
        if (!exists) return (default, Results.BadRequest(new { error = "member_not_found" }));

        if (await BookingMembershipGate.RefuseIfBarredAsync(db, userId.Value, ct) is { } barred)
        {
            return (default, barred);
        }

        // A guest name BESIDE a real member does not make the row a block — it is that
        // member's paid booking — so the name goes on AdminNote instead.
        return (new BulkBookRequestContext(userId, guest, guest, req.AllowNegativeBalance, key), null);
    }

    /// <summary>The two bounds every batch shares, refused before anything is attempted.</summary>
    private static IResult? Validate(string? idempotencyKey, int itemCount, int maxItems)
    {
        var key = idempotencyKey?.Trim();
        if (string.IsNullOrEmpty(key) || key.Length > BulkSettings.MaxIdempotencyKeyLength)
        {
            return Results.BadRequest(new { error = "idempotency_key_invalid" });
        }

        if (itemCount == 0) return Results.BadRequest(new { error = "no_items" });
        if (itemCount > maxItems)
        {
            return Results.BadRequest(new { error = "too_many_items", max_items = maxItems });
        }

        return null;
    }
}

/// <summary>One ticked booking. <c>waivePenalty</c> overrides the batch default for this row only.</summary>
public sealed record BulkCancelRequestItem(Guid BookingId, bool? WaivePenalty = null);

/// <summary>
/// A list of bookings an admin ticked, with one reason for all of them.
///
/// <para>
/// The reason is required and is used as the waiver reason for every item, because
/// <c>feature-spec.md</c> §7 requires a waiver to be "logged with reason" and a batch has one
/// reason by construction.
/// </para>
/// </summary>
public sealed record BulkCancelRequest(
    string? IdempotencyKey, string? Reason, bool WaivePenalty = false,
    IReadOnlyList<BulkCancelRequestItem>? Items = null);

/// <summary>Who a batch is booked for. At least one of the two, or neither for the admin's own booking.</summary>
public sealed record BulkBookOnBehalf(Guid? UserId = null, string? GuestName = null);

/// <summary>One slot in a bulk book.</summary>
public sealed record BulkBookRequestItem(Guid CourtId, DateTimeOffset StartsAt, int SliceCount);

/// <summary>A list of slots an admin wants booked, all for the same payer.</summary>
public sealed record BulkBookRequest(
    string? IdempotencyKey, BulkBookOnBehalf? OnBehalf = null, bool AllowNegativeBalance = false,
    string? Note = null, IReadOnlyList<BulkBookRequestItem>? Items = null);
