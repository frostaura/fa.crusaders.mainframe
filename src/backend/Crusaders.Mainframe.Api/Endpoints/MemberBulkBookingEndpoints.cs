using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// D8 — <c>POST /api/v1/bookings/bulk</c>, the member's multiselect. The semantics, and why they
/// match the admin bulk's, are on <see cref="MemberBulkBookingService"/>.
///
/// <para>
/// <b>Any signed-in member, not admins only</b> — the route sits beside the single member booking
/// route and is bounded the same way: the <c>auth</c> rate limiter, because a batch is an
/// amplification factor of up to <c>admin_bulk_max_items</c> payer locks and GiST writes per
/// request, and the club's own bulk ceiling, because there is one number for "how many courts one
/// request may take" and a second, member-only number would be a setting nobody knows to change.
/// </para>
///
/// <para>
/// <b>The request is camelCase and the answer is snake_case</b>, as every POST in this API and its
/// client are (<c>src/frontend/src/lib/api.ts</c>, D2 §13); the item shape is the admin bulk's
/// <see cref="BulkBookRequestItem"/> exactly, so the grid sends one shape to either route.
/// </para>
/// </summary>
public static class MemberBulkBookingEndpoints
{
    public static IEndpointRouteBuilder MapMemberBulkBookingEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/bookings")
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Auth);

        g.MapPost("/bulk", BookAsync);

        return app;
    }

    /// <summary>Everything the handler resolves, bound as one parameter for the complexity gate.</summary>
    public sealed record MemberBulkDeps(
        MemberBulkBookingService Bulk, TenantSettingsAccessor Settings, MainframeDbContext Db, LedgerService Ledger);

    /// <summary>
    /// Books the caller's ticked slots. Refusals of the REQUEST are 400s (a key, an empty list, too
    /// many items) or the membership gate's 403; refusals of an ITEM are data in a 200.
    /// </summary>
    public static async Task<IResult> BookAsync(
        MemberBulkBookRequest req, HttpContext ctx, [AsParameters] MemberBulkDeps deps, CancellationToken ct)
    {
        var items = req.Items ?? [];
        var view = await deps.Settings.GetAsync(ct);
        if (Validate(req.IdempotencyKey, items.Count, BulkSettings.MaxItems(view)) is { } bad) return bad;

        var userId = ctx.User.Id() ?? Guid.Empty;

        // The same gate the single route asks, once for the batch: it is about the caller, not
        // about any slot, so asking it per item would only repeat the answer.
        if (await BookingMembershipGate.RefuseIfBarredAsync(deps.Db, userId, ct) is { } barred) return barred;

        // D11: a players payload is checked in full before anything is booked — its shape on its
        // own, then the split against EVERY item's own price. A batch whose players or split
        // cannot work on any one item books nothing; there is no half-split batch.
        if (req.Players is { Count: > 0 } && await PlayersRefusalAsync(ctx, userId, req, items, ct) is { } badPlayers)
        {
            return badPlayers;
        }

        var before = await deps.Ledger.GetBalanceAsync(userId, ct);
        var outcome = await deps.Bulk.BookAsync(
            items.Select(i => new BulkBookItem(i.CourtId, i.StartsAt, i.SliceCount)).ToList(),
            new MemberBulkRequest(userId, ctx.User.IsInRole("admin"), req.IdempotencyKey!.Trim()), ct);
        var after = await deps.Ledger.GetBalanceAsync(userId, ct);

        // D11: the same players on every NEWLY booked item. A replayed item already has its seats
        // from the first attempt, and adding them again would invite everybody twice.
        var players = new List<object>();
        if (req.Players is { Count: > 0 })
        {
            var svc = ctx.RequestServices.GetRequiredService<PlayersService>();
            var spec = new PlayersRequest(req.Players, req.SplitMode, req.OrganiserWeight);
            foreach (var r in outcome.Results.Where(r => r.Status == MemberBulkStatuses.Booked && !r.Replayed && r.BookingId is not null))
            {
                var added = await svc.AddAsync(r.BookingId!.Value, userId, spec, ct);
                players.Add(new { booking_id = r.BookingId, players = added.IsOk ? added.Body : null, players_error = added.IsOk ? null : added.Error });
            }
        }

        return Results.Ok(Body(outcome, before, after, players));
    }

    /// <summary>
    /// The answer. <c>total_charged_credits</c> is what the booked items cost, replays included, so
    /// a retried batch answers the same total; <c>charged_now_credits</c> is what THIS request
    /// debited, which is what the balance pair beside it moved by. Block body for the lizard reason.
    /// </summary>
    private static object Body(MemberBulkOutcome outcome, decimal before, decimal after, List<object> players)
    {
        var booked = outcome.Results.Where(r => r.Status == MemberBulkStatuses.Booked).ToList();
        return new
        {
            requested = outcome.Results.Count,
            booked = booked.Count,
            refused = outcome.Results.Count - booked.Count,
            total_charged_credits = booked.Sum(r => r.AmountCredits),
            charged_now_credits = booked.Where(r => !r.Replayed).Sum(r => r.AmountCredits),
            balance_before_credits = before,
            balance_after_credits = after,
            halted_at = outcome.HaltedAt,
            halted_reason = outcome.HaltedReason,
            results = outcome.Results.Select(Row).ToList(),
            players,
        };
    }

    /// <summary>One item's answer. Block body for the lizard reason.</summary>
    private static object Row(MemberBulkResult r)
    {
        return new
        {
            index = r.Index,
            court_id = r.CourtId,
            court_name = r.CourtName,
            starts_at = r.StartsAt,
            ends_at = r.EndsAt,
            status = r.Status,
            reason = r.Reason,
            booking_id = r.BookingId,
            amount_credits = r.AmountCredits,
            replayed = r.Replayed,
        };
    }

    /// <summary>
    /// The players payload against the whole batch: its shape once, price-free, then the split
    /// against each item the rules will price. An item that cannot be quoted is refused as an item
    /// by the batch itself and is never split, so only its shape was ever at stake.
    /// </summary>
    private static async Task<IResult?> PlayersRefusalAsync(
        HttpContext ctx, Guid userId, MemberBulkBookRequest req, IReadOnlyList<BulkBookRequestItem> items, CancellationToken ct)
    {
        var players = ctx.RequestServices.GetRequiredService<PlayersService>();
        var spec = new PlayersRequest(req.Players, req.SplitMode, req.OrganiserWeight);
        if (await players.ValidateAsync(userId, spec, null, ct) is { } shape) return PlayersEndpoints.ToResult(shape);

        var bookings = ctx.RequestServices.GetRequiredService<BookingService>();
        var payer = new BookingPayer(userId, userId, ActorIsAdmin: ctx.User.IsInRole("admin"));
        // One after another: every quote reads through the request's one DbContext.
        var checkedPrices = new HashSet<decimal>();
        foreach (var item in items)
        {
            var price = (await bookings.QuoteAsync(item.CourtId, payer, item.StartsAt, item.SliceCount, ct)).PriceCredits;
            if (price is not { } p || !checkedPrices.Add(p)) continue;
            if (await players.ValidateAsync(userId, spec, p, ct) is { } bad) return PlayersEndpoints.ToResult(bad);
        }
        return null;
    }

    /// <summary>The admin bulk's two request bounds, with the admin bulk's refusal codes.</summary>
    private static IResult? Validate(string? idempotencyKey, int itemCount, int maxItems)
    {
        var key = idempotencyKey?.Trim();
        if (string.IsNullOrEmpty(key) || key.Length > BulkSettings.MaxIdempotencyKeyLength)
        {
            return Results.BadRequest(new { error = "idempotency_key_invalid" });
        }

        if (itemCount == 0) return Results.BadRequest(new { error = "no_items" });
        if (itemCount > maxItems) return Results.BadRequest(new { error = "too_many_items", max_items = maxItems });

        return null;
    }
}

/// <summary>
/// A member's ticked slots. There is no payer, no on-behalf and no overdraft field — the payer is
/// the caller, and a member has no way to ask to be overdrawn.
/// </summary>
public sealed record MemberBulkBookRequest(
    string? IdempotencyKey, IReadOnlyList<BulkBookRequestItem>? Items = null,
    IReadOnlyList<PlayerSpec>? Players = null, string? SplitMode = null, int? OrganiserWeight = null);
