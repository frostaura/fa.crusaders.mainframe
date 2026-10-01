using System.Text.Json.Serialization;
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
            .RequireRateLimiting(RateLimitPolicies.Writes);

        g.MapPost("/bulk-cancel", CancelAsync);
        g.MapPost("/bulk", BookAsync);

        // Not under `auth`: that bucket is ten a minute per user and shared with the batch this
        // prices, so a console re-quoting as the admin edits the list starved the real booking
        // into a 429. A quote writes nothing and takes no lock; the global per-IP bucket bounds it
        // as it bounds every other read. See BookingEndpoints' single quote for the same move.
        app.MapGroup("/api/v1/admin/bookings")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .MapPost("/bulk/quote", QuoteAsync);

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
        // Review round 1 (lane F1): what each partner had paid, so each item can say what went
        // back to them and what the organiser keeps — the member cancel's truth, in bulk.
        var split = ctx.RequestServices.GetRequiredService<SplitCancelView>();
        var paidBefore = new Dictionary<Guid, Dictionary<Guid, decimal>>();
        foreach (var item in items) paidBefore[item.BookingId] = await split.PaidByPartnerAsync(item.BookingId, ct);
        var outcome = await bulk.CancelAsync(
            items.Select(i => new BulkCancelItem(i.BookingId, i.WaivePenalty)).ToList(),
            req.IdempotencyKey!.Trim(), reason, req.WaivePenalty, actorId, ct);

        var succeeded = outcome.Results.Count(r => r.Succeeded);

        // D11: each cancelled booking's partners are refunded their shares.
        await ctx.AfterSettlementAsync(outcome.Results.Where(r => r.Succeeded).Select(r => (Guid?)r.BookingId), ct);
        var refunds = new Dictionary<Guid, List<PartnerRefund>>();
        foreach (var r in outcome.Results.Where(r => r.Succeeded))
        {
            refunds[r.BookingId] = await split.AfterAsync(r.BookingId, paidBefore.GetValueOrDefault(r.BookingId) ?? [], ct);
        }

        // ONE summary row per BATCH — the INTENT, the admin's own words about why a list of courts
        // went away. Since review round 5 (A5-2) it is not the only record: each booking the batch
        // cancelled also has the member-facing booking.cancelled_by_admin row a single desk cancel
        // writes (staged in AdminBulkBookingService, in that booking's own save), because a
        // member's record never showed a court the desk took from a list.
        // Review round 5 (A5-2): the summary names its bookings — a label for the list and one
        // entry per item — so it reads as one decision about named courts, not a row of ids.
        await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingsBulkCancelled,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.Booking,
            SubjectLabel: BulkRecordLabels.Of(outcome.Results.Select(r => r.MemberName ?? r.BlockLabel).ToList()),
            Reason: reason,
            After: new
            {
                requested = outcome.Results.Count,
                succeeded,
                failed = outcome.Results.Count - succeeded,
                total_refunded_credits = outcome.TotalRefundedCredits,
                total_penalty_credits = outcome.TotalPenaltyCredits,
                booking_ids = outcome.Results.Select(r => r.BookingId).ToList(),
                bookings = outcome.Results.Select(r => new
                {
                    booking_id = r.BookingId,
                    member_name = r.BlockLabel is null ? r.MemberName : null,
                    block_label = r.BlockLabel,
                    court = r.CourtName,
                    starts_at = r.StartsAt,
                    status = r.Status,
                    refund_credits = r.RefundCredits,
                    penalty_credits = r.PenaltyCredits,
                }).ToList(),
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
                // Gross refund less the penalty row less the partners' refunds (M5-7, as the single cancel).
                net_credits = r.RefundCredits - r.PenaltyCredits - refunds.GetValueOrDefault(r.BookingId, []).Sum(x => x.Credits),
                partner_refunds = refunds.GetValueOrDefault(r.BookingId, []),
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

        var (resolved, refusal) = await ResolveOnBehalfAsync(req, actorId, db, ct);
        if (refusal is not null) return refusal;

        // The role claim, not an inference. This group is RequireRole("admin"), so the answer is
        // always true today — but D2-B13 is exactly the bug of deciding "is this an admin?" from
        // something other than the claim, and a batch that lost the exemption would be refused
        // item by item with member-class reason codes rather than failing loudly.
        var context = resolved with { ActorIsAdmin = ctx.User.IsInRole("admin") };

        // The payer as they were before the batch, read once. An admin needs the pair to
        // explain a top-up to the member standing in front of them, and re-reading it per item
        // would report the balance after the last booking as the balance before the first.
        var before = context.PayerUserId is { } payer ? await ledger.GetBalanceAsync(payer, ct) : (decimal?)null;

        var outcome = await bulk.BookAsync(
            items.Select(i => new BulkBookItem(i.CourtId, i.StartsAt, i.SliceCount)).ToList(),
            context, actorId, ct);

        var after = context.PayerUserId is { } payerAfter ? await ledger.GetBalanceAsync(payerAfter, ct) : (decimal?)null;
        var succeeded = outcome.Results.Count(r => r.Succeeded);
        var payerName = context.PayerUserId is { } id
            ? PersonNames.Of(id, await PersonNames.ForAsync(db, [id], ct))
            : null;

        // A5-2: the row is labelled with whom the batch was for (the payer, else the guest) — it
        // was null for every member batch — and lists each item it tried.
        await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingsBulkBooked,
            ActorUserId: actorId,
            SubjectKind: context.PayerUserId is null ? AdminChangeSubjects.Booking : AdminChangeSubjects.User,
            SubjectId: context.PayerUserId,
            SubjectLabel: payerName ?? context.GuestName,
            Reason: req.Note?.Trim(),
            After: new
            {
                requested = outcome.Results.Count,
                succeeded,
                failed = outcome.Results.Count - succeeded,
                total_charged_credits = outcome.TotalChargedCredits,
                booking_ids = outcome.Results.Where(r => r.BookingId is not null)
                    .Select(r => r.BookingId!.Value).ToList(),
                bookings = outcome.Results.Select(r => new
                {
                    index = r.Index,
                    booking_id = r.BookingId,
                    court = r.CourtName,
                    starts_at = r.StartsAt,
                    status = r.Status,
                    error = r.Error,
                    amount_credits = r.AmountCredits,
                }).ToList(),
            }), ct);
        await db.SaveChangesAsync(ct);

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

    // ------------------------------------------------------------------ quote

    /// <summary>
    /// <c>POST /api/v1/admin/bookings/bulk/quote</c> — what a batch would cost its payer, item
    /// by item, and whether it takes them below zero, before anything is booked (decision R19).
    ///
    /// <para>
    /// The single-booking quote's reasoning applies whole: the console reads the consequence
    /// first and then sends <c>allowNegativeBalance</c> deliberately, instead of learning about
    /// a short balance from a halted batch. Every item is priced by the booking's own path (see
    /// <see cref="AdminBulkBookingService.QuoteAsync"/>); refusals are per-item <c>reason</c>
    /// codes in the booking's own vocabulary, never a failed request.
    /// </para>
    ///
    /// <para>
    /// <b>Both spellings bind</b> — <c>user_id</c>/<c>court_id</c>/<c>starts_at</c>/<c>slices</c>
    /// and the bulk book body's own <c>userId</c>/<c>courtId</c>/<c>startsAt</c>/<c>sliceCount</c>
    /// — for the reason <c>AdjustRequest</c> documents: the wrong side of this API's
    /// camel/snake split binds to null rather than failing, and a console that sends the same
    /// items array to the quote and then to the book must not have one of the two quietly empty.
    /// </para>
    ///
    /// <para>
    /// No guest shape: a written-in guest becomes an admin block that charges nobody, so there
    /// is nothing to quote. No idempotency key: nothing is written.
    /// </para>
    /// </summary>
    private static async Task<IResult> QuoteAsync(
        BulkQuoteRequest req, HttpContext ctx, [AsParameters] BulkDeps deps, CancellationToken ct)
    {
        var view = await deps.Settings.GetAsync(ct);
        var (items, invalid) = QuoteItems(req, BulkSettings.MaxItems(view));
        if (invalid is not null) return invalid;

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var payerId = req.UserId ?? req.UserIdCamel ?? actorId;

        // The same two refusals the bulk book gives for the same payer, in the same order.
        if (payerId != actorId
            && !await deps.Db.Users.AsNoTracking().AnyAsync(u => u.Id == payerId, ct))
        {
            return Results.BadRequest(new { error = "member_not_found" });
        }
        if (await BookingMembershipGate.RefuseIfBarredAsync(deps.Db, payerId, ct) is { } barred) return barred;

        var payer = new BookingPayer(payerId, actorId, ActorIsAdmin: ctx.User.IsInRole("admin"));
        var quote = await deps.Bulk.QuoteAsync(items, payer, ct);
        var anyBookable = quote.Lines.Any(l => l.Bookable);

        return Results.Ok(new
        {
            user_id = payerId,
            total_credits = quote.TotalCredits,
            balance_credits = quote.BalanceCredits,
            spendable_credits = quote.SpendableCredits,
            held_credits = quote.HeldCredits,
            owed_back_credits = quote.OwedBackCredits,
            balance_after_credits = quote.BalanceCredits - quote.TotalCredits,
            // True exactly when the batch sent WITHOUT the flag would halt on
            // insufficient_balance. Prices are never negative, so the running balance first
            // falls short of an item's price iff the balance is below the whole total.
            overdraws = anyBookable && quote.SpendableCredits < quote.TotalCredits,
            items = quote.Lines.Select((l, index) => new
            {
                index,
                court_id = l.Item.CourtId,
                court_name = l.CourtName,
                starts_at = l.Item.StartsAt,
                slices = l.Item.SliceCount,
                price_credits = l.PriceCredits,
                bookable = l.Bookable,
                reason = l.Reason,
            }).ToList(),
        });
    }

    /// <summary>The items of a quote under either spelling, or the 400 for the first bad one.</summary>
    private static (List<BulkBookItem> Items, IResult? Invalid) QuoteItems(BulkQuoteRequest req, int maxItems)
    {
        var raw = req.Items ?? [];
        if (raw.Count == 0) return ([], Results.BadRequest(new { error = "no_items" }));
        if (raw.Count > maxItems) return ([], Results.BadRequest(new { error = "too_many_items", max_items = maxItems }));

        var items = new List<BulkBookItem>(raw.Count);
        for (var index = 0; index < raw.Count; index++)
        {
            var i = raw[index];
            var courtId = i.CourtId ?? i.CourtIdCamel;
            var startsAt = i.StartsAt ?? i.StartsAtCamel;
            var slices = i.Slices ?? i.SliceCountCamel;
            if (courtId is null || startsAt is null || slices is null)
            {
                return ([], Results.BadRequest(new { error = "item_invalid", index }));
            }
            items.Add(new BulkBookItem(courtId.Value, startsAt.Value, slices.Value));
        }

        return (items, null);
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

/// <summary>
/// One slot in a bulk quote, under either spelling — see <c>AdminBulkBookingEndpoints.QuoteAsync</c>.
/// </summary>
public sealed record BulkQuoteRequestItem(
    [property: JsonPropertyName("court_id")] Guid? CourtId = null,
    [property: JsonPropertyName("starts_at")] DateTimeOffset? StartsAt = null,
    [property: JsonPropertyName("slices")] int? Slices = null,
    [property: JsonPropertyName("courtId")] Guid? CourtIdCamel = null,
    [property: JsonPropertyName("startsAt")] DateTimeOffset? StartsAtCamel = null,
    [property: JsonPropertyName("sliceCount")] int? SliceCountCamel = null);

/// <summary>
/// A batch to price. <c>user_id</c> is the payer and defaults to the calling admin.
/// </summary>
public sealed record BulkQuoteRequest(
    [property: JsonPropertyName("user_id")] Guid? UserId = null,
    [property: JsonPropertyName("items")] IReadOnlyList<BulkQuoteRequestItem>? Items = null,
    [property: JsonPropertyName("userId")] Guid? UserIdCamel = null);

/// <summary>
/// The label a bulk change row carries (review round 5, A5-2): how many bookings, and whose —
/// "3 bookings — Olga Smith, Ben Ng and 1 more". It was null, so the record read "Cancelled
/// several bookings at once" about nobody. Names are distinct, in the batch's order.
/// </summary>
public static class BulkRecordLabels
{
    private const int Named = 2;

    public static string Of(IReadOnlyList<string?> names)
    {
        var count = names.Count == 1 ? "1 booking" : $"{names.Count} bookings";
        var distinct = names.Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n!.Trim()).Distinct().ToList();
        if (distinct.Count == 0) return count;
        var shown = string.Join(", ", distinct.Take(Named));
        var more = distinct.Count - Named;
        return more > 0 ? $"{count} — {shown} and {more} more" : $"{count} — {shown}";
    }
}
