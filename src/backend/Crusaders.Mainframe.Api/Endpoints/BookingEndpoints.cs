using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class BookingEndpoints
{
    public static IEndpointRouteBuilder MapBookingEndpoints(this IEndpointRouteBuilder app)
    {
        // D2-B43: these routes carried no limiter, only the global 600/min per IP. With no
        // slice-boundary validation (fixed in BookingService) an authenticated member could
        // issue unbounded bookings at arbitrary offsets, each taking a PayerLock and a GiST
        // index write. Booking is a deliberate human action, not a poll, so it is bounded per
        // member — by `writes` since the perf round, not `auth`'s ten a minute, which it shared
        // with password guessing and which 429'd the eleventh booking-ish call in a minute.
        var g = app.MapGroup("/api/v1/bookings")
            .RequireAuthorization()
            .RequireRateLimiting(Security.RateLimitPolicies.Writes);

        // A quote is a read: it answers under the global backstop only, and never spends the
        // budget of the cancel it is quoting (the admin quotes learned the same, P2-1).
        app.MapGroup("/api/v1/bookings").RequireAuthorization()
            .MapGet("/{bookingId:guid}/cancellation-quote", MemberCancelQuoteAsync);

        g.MapPost("/", async (CreateBookingRequest req, HttpContext ctx, BookingService svc, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;

            // Sign-in already refuses a barred member, but a token minted before the club
            // changed its mind stays valid until it expires — and booking court time is
            // exactly what a suspension is stopping. Here rather than in BookingService
            // because it asks about the caller, not about the slot. The rule, and why it is
            // not-Active rather than Suspended, is on BookingMembershipGate.
            if (await BookingMembershipGate.RefuseIfBarredAsync(db, userId, ct) is { } refused) return refused;

            // The member's OWN route. ActorIsAdmin is taken from the claim rather than left
            // false, because an admin booking for themselves through the member route is still
            // an admin — GOAL item 19's "with the exception of admins", and the half D2-B13's
            // actorId != userId inference got exactly backwards.
            var payer = new BookingPayer(userId, userId, ActorIsAdmin: ctx.User.IsInRole("admin"));
            if (req.Players is not { Count: > 0 })
            {
                return ToHttpResult(await svc.CreateAsync(req.CourtId, payer, req.StartsAt, req.SliceCount, ct), ctx);
            }
            return await CreateWithPlayersAsync(req, payer, ctx, svc, ct);
        });

        g.MapPost("/{bookingId:guid}/cancel", MemberCancelAsync);

        // Admin: book on behalf + cancel-with-waive
        var admin = app.MapGroup("/api/v1/admin/bookings")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .RequireRateLimiting(Security.RateLimitPolicies.Writes);

        // §8: "Book on behalf of any member (charges that member's credit; if insufficient,
        // admin can override and create a negative balance, logged)."
        //
        // `allowNegativeBalance` is the override, and it exists on THIS request record and
        // not on the member's own — a member has no way to send it, and the service refuses
        // it anyway unless the actor holds the admin role. Since decision R19 the payer may be
        // the admin themselves (userId = self): god mode is the admin route, never the member
        // one. The console reads GET /quote first and sends the flag deliberately; the 402 is
        // still the answer to a request that did not ask for it. Nothing here makes the
        // overdraft the default.
        admin.MapPost("/", async (AdminBookingRequest req, HttpContext ctx, BookingService svc, MainframeDbContext db, CancellationToken ct) =>
        {
            // The PAYER, not the desk. This route tested membership status not at all, so an
            // admin could book for an unapproved applicant: charged, absent from the box
            // roster, refused `no_booking` at every courtside door, then swept as a no-show
            // with the 30% penalty. Driven end to end — 50 credits for a court that cannot open.
            if (await BookingMembershipGate.RefuseIfBarredAsync(db, req.UserId, ct) is { } refused) return refused;

            var actorId = ctx.User.Id() ?? Guid.Empty;
            // ActorIsAdmin comes from the ROUTE GROUP's role claim — this group is
            // RequireRole("admin") — and is never re-derived from actorId != userId. That
            // inference is D2-B13: it made an admin booking for themselves NOT exempt, and it
            // never asked whether the actor held the role at all.
            var payer = new BookingPayer(
                req.UserId, actorId, req.AllowNegativeBalance, ActorIsAdmin: ctx.User.IsInRole("admin"));
            var result = await svc.CreateAsync(req.CourtId, payer, req.StartsAt, req.SliceCount, ct);
            return ToHttpResult(result, ctx);
        });

        admin.MapPost("/{bookingId:guid}/cancel", AdminCancelAsync);

        // R19: the consequence, before the booking. See AdminQuoteAsync.
        //
        // In a group of its own WITHOUT the `auth` limiter. That bucket is ten a minute per
        // user and is shared with the booking it quotes: the console re-quotes as the admin
        // changes the member, the length or the slot, so ten quotes in a minute made the
        // booking they were for answer 429. A quote writes nothing and takes no lock — it is a
        // read, bounded by the global per-IP bucket like every other read.
        app.MapGroup("/api/v1/admin/bookings")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .MapGet("/quote", AdminQuoteAsync);

        // Admin: block a slot for an event.
        //
        // §8 has promised this since the first spec and §5 lists `admin_block` as a slot
        // state with a label — `SlotCell` could already RENDER one. Nothing in the product
        // could create one, in either half: no endpoint, no screen. A club running a
        // tournament had to book every court out under a member's name.
        var blocks = app.MapGroup("/api/v1/admin/blocks").RequireAuthorization(p => p.RequireRole("admin"));

        blocks.MapPost("/", async (CreateBlockRequest req, HttpContext ctx, AdminBlockService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CreateAsync(req.CourtId, req.StartsAt, req.SliceCount, req.Label, actorId, ct);
            return ToHttpResult(result, ctx);
        });

        blocks.MapDelete("/{blockId:guid}", async (Guid blockId, HttpContext ctx, AdminBlockService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            return await svc.RemoveAsync(blockId, actorId, ct)
                ? Results.NoContent()
                : Results.NotFound(new { error = "block_not_found" });
        });

        return app;
    }

    /// <summary>
    /// D11 — a booking made with its players (the BookSheet's Players and Split steps).
    ///
    /// <para>
    /// <b>Validated in full before anything is booked</b>: the players, the seats and the split,
    /// against the price the booking would actually charge (<see cref="BookingService.QuoteAsync"/>,
    /// the same path the booking takes). A request whose split cannot work books nothing. The
    /// booking is then made exactly as a single-player one is — the organiser pays the whole price
    /// — and the seats are added beside it. Should adding them fail after all (a member suspended
    /// in the gap), the booking stands and the answer says so in <c>players_error</c>; the organiser
    /// can invite again from the booking.
    /// </para>
    /// </summary>
    private static async Task<IResult> CreateWithPlayersAsync(
        CreateBookingRequest req, BookingPayer payer, HttpContext ctx, BookingService svc, CancellationToken ct)
    {
        var players = ctx.RequestServices.GetRequiredService<PlayersService>();
        var spec = new PlayersRequest(req.Players, req.SplitMode, req.OrganiserWeight);

        // The shape first, price-free, so a malformed players payload is refused even when the
        // slot itself cannot be quoted; then the split against the price the booking will charge.
        var quote = await svc.QuoteAsync(req.CourtId, payer, req.StartsAt, req.SliceCount, ct);
        if (await players.ValidateAsync(payer.UserId, spec, quote.PriceCredits, ct) is { } bad)
        {
            return PlayersEndpoints.ToResult(bad);
        }

        var result = await svc.CreateAsync(req.CourtId, payer, req.StartsAt, req.SliceCount, ct);
        if (result is not BookingResult.Ok ok) return ToHttpResult(result, ctx);

        var added = await players.AddAsync(ok.Booking.Id, payer.UserId, spec, ct);
        return Results.Ok(new
        {
            booking_id = ok.Booking.Id,
            balance_after_credits = ok.BalanceAfterCredits,
            players = added.IsOk ? added.Body : null,
            players_error = added.IsOk ? null : added.Error,
        });
    }

    /// <summary>
    /// §8's "cancel any booking on behalf of any member (penalty waiveable <b>with
    /// reason</b>)", and §7's "logged with reason".
    ///
    /// <para>
    /// The reason did not exist on the wire at all, so the audit row carried a bare
    /// <c>waived: true</c> and a club reviewing waived penalties at month end could not tell
    /// a genuine club decision from a quiet favour. It is refused rather than defaulted: an
    /// audit field that may be left blank is one that always is. A cancellation that waives
    /// nothing needs no reason — the requirement belongs to the waiver, not to the route.
    /// </para>
    ///
    /// <para>
    /// A named method rather than a lambda so <c>MapBookingEndpoints</c> stays a list of
    /// routes; the decision below is the only one of them with a rule of its own.
    /// </para>
    /// </summary>
    private static async Task<IResult> AdminCancelAsync(
        Guid bookingId, AdminCancelRequest? req, HttpContext ctx, BookingService svc, CancellationToken ct)
    {
        var actorId = ctx.User.Id() ?? Guid.Empty;
        var waive = req?.WaivePenalty ?? false;
        // Review round 4 (A4-4): every desk cancellation says why, waiver or not — the reason is
        // the only record of why the club took somebody's court, and it is mailed to them. The
        // waiver's own field still counts as the reason, so a console that sends only it works.
        var reason = (string.IsNullOrWhiteSpace(req?.Reason) ? req?.WaiveReason : req.Reason)?.Trim();
        if (string.IsNullOrEmpty(reason))
            return Results.BadRequest(new { error = waive ? "waive_reason_required" : "reason_required" });

        // Staged BEFORE the cancellation so it flushes in the cancellation's own save (A4-4):
        // the ledger saves through this context, and a record of a cancellation that rolled
        // back is worse than none. Withdrawn if nothing was cancelled.
        var record = await AdminCancelRecord.StageAsync(ctx, bookingId, actorId, reason, ct);

        // Review round 1 (lane F1): the desk sees the same truthful split refund the member does.
        var split = ctx.RequestServices.GetRequiredService<SplitCancelView>();
        var paidBefore = await split.PaidByPartnerAsync(bookingId, ct);
        var result = await svc.CancelAsync(bookingId, actorId, actorIsAdmin: true, waivePenalty: waive, ct, reason);
        if (result is not CancellationResult.Ok ok)
        {
            AdminCancelRecord.Withdraw(ctx, record);
            return ToHttpResult(result, ctx);
        }
        await ctx.AfterSettlementAsync([bookingId], ct);
        return CancelledAnswer(ok, await split.AfterAsync(bookingId, paidBefore, ct));
    }

    /// <summary>A settled cancellation's answer: the refund, the penalty, each partner's refund and the organiser's net (B3).</summary>
    private static IResult CancelledAnswer(CancellationResult.Ok ok, List<PartnerRefund> refunds)
    {
        return Results.Ok(new
        {
            refunded_credits = ok.RefundedCredits,
            penalty_credits = ok.PenaltyCredits,
            net_credits = ok.RefundedCredits - refunds.Sum(r => r.Credits),
            partner_refunds = refunds,
        });
    }

    /// <summary>
    /// <c>GET /api/v1/admin/bookings/quote?userId&amp;courtId&amp;startsAt&amp;slices</c> — what a
    /// booking would cost its payer and where it would leave their balance, before anything is
    /// booked (decision R19).
    ///
    /// <para>
    /// <b>Why it exists.</b> The console used to learn about a short balance by being refused:
    /// POST, read the 402, show the figures, POST again with the override. That made the
    /// override something an admin reaches for after a failure rather than a consequence they
    /// read up front — "this takes Naledi to −16 cr" — and then choose. The quote answers the
    /// question first so the flag is sent deliberately.
    /// </para>
    ///
    /// <para>
    /// <b>The price is the booking's price.</b> It comes from
    /// <see cref="BookingService.QuoteAsync"/>, which is the same code path the booking runs up
    /// to the point money would move — group pricing, court price, every rule. A refusal the
    /// booking would meet is answered with the SAME status and body the POST would give, so the
    /// console has one mapping for both. The balance guard is not a refusal here; it is the
    /// <c>overdraws</c> flag.
    /// </para>
    ///
    /// <para>
    /// <b>No <c>currency_symbol</c>.</b> Every figure here is credits, and
    /// <see cref="CurrencySymbol"/> records the decision that the club's symbol is rand's and
    /// never goes in front of a credit figure.
    /// </para>
    ///
    /// <para>
    /// <c>userId</c> is optional and defaults to the admin, so the admin's own booking is quoted
    /// the same way. The payer is gated exactly as the POST gates them.
    /// </para>
    /// </summary>
    private static async Task<IResult> AdminQuoteAsync(
        [AsParameters] AdminQuoteQuery raw, HttpContext ctx, BookingService svc,
        MainframeDbContext db, LedgerService ledger, CancellationToken ct)
    {
        if (raw.Parse() is not { } query) return Results.BadRequest(new { error = "quote_query_invalid" });

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var payerId = query.UserId ?? actorId;
        if (await BookingMembershipGate.RefuseIfBarredAsync(db, payerId, ct) is { } refused) return refused;

        // The payer the POST would build, flag and all, so the quote walks the rules as the
        // admin's booking will — an on-behalf booking skips the caps, a self-booking skips
        // everything.
        var payer = new BookingPayer(payerId, actorId, ActorIsAdmin: ctx.User.IsInRole("admin"));
        var quote = await svc.QuoteAsync(query.CourtId, payer, query.StartsAt, query.Slices, ct);
        if (quote.PriceCredits is not { } price) return ToHttpResult(quote.Refusal!, ctx);

        // balance_credits is the raw balance, as everywhere; the guard is on SPENDABLE — shares the
        // member holds for their partners are not the desk's to book against (D11).
        var held = await ledger.GetHeldAsync(payerId, ct);
        var balance = await ledger.GetBalanceAsync(payerId, ct);
        var spendable = balance - held.Reserved;
        return Results.Ok(new
        {
            user_id = payerId,
            court_id = query.CourtId,
            court_name = quote.CourtName,
            starts_at = query.StartsAt,
            ends_at = quote.EndsAt,
            slices = query.Slices,
            price_credits = price,
            balance_credits = balance,
            balance_after_credits = balance - price,
            spendable_credits = spendable,
            held_credits = held.Held,
            owed_back_credits = held.OwedBack,
            // Exactly the guard CreateAsync applies, `spendable < totalCost`, so "overdraws" is
            // true precisely when the POST without the flag would answer 402.
            overdraws = spendable < price,
        });
    }

    /// <summary>
    /// Every <see cref="BookingResult"/> the service can return, as an HTTP answer with a
    /// stable snake_case <c>error</c> code the client maps to a sentence.
    ///
    /// <para>
    /// This used to be four copies of a switch that named seven of the ten arms, ending in
    /// <c>_ =&gt; Results.Problem("Unexpected")</c>. The two headline rules of the whole
    /// booking model — peak-hour league exclusivity and the per-day cap — fell into that
    /// default, so a member who hit either got HTTP 500 and the sentence "Booking failed."
    /// The service had already composed the exact refusal, with the peak window and the
    /// member's own minutes in it, and the endpoint threw it away. Worse, nothing reached
    /// the log: <c>Results.Problem</c> is a return, not a throw, so an operator watching
    /// <c>api.log</c> saw no trace of a rule refusing anybody, ever.
    /// </para>
    ///
    /// <para>
    /// One copy now, and the fallback is a logged 500 rather than a silent one — a new
    /// result type reaching it is a defect that says so out loud. Adding a result type
    /// without adding an arm here is still possible; the arms are ordered to match the
    /// declaration order in <c>BookingService.cs</c> so the pair reads as one list.
    /// </para>
    /// </summary>
    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch or an
    // object initialiser as the END of the function and dumps the rest of the file into a
    // *global* pseudo-function whose length trips `-L 200`. See memory/gotchas.md and
    // whitelizard.txt's header.
    internal static IResult ToHttpResult(BookingResult result, HttpContext ctx)
    {
        // The wire word is BookingRefusals' — the one mapping every booking path reads — and
        // this switch adds only the status and the figures each refusal's sentence needs.
        var error = BookingRefusals.CodeOf(result);
        return result switch
        {
            BookingResult.Ok ok => Results.Ok(new { booking_id = ok.Booking.Id, balance_after_credits = ok.BalanceAfterCredits }),
            BookingResult.NotFound => Results.NotFound(new { error }),
            BookingResult.PastTime => Results.BadRequest(new { error }),
            BookingResult.TooFarAhead => Results.BadRequest(new { error }),
            BookingResult.SlotTaken => Results.Conflict(new { error }),
            BookingResult.InsufficientBalance ib => Results.Json(
                new { error, current_credits = ib.CurrentCredits, required_credits = ib.RequiredCredits }, statusCode: 402),
            // withheld_by_groups (D2): the member's own groups that do not grant peak priority, so
            // the sentence can name the rule that stopped them. Empty when they are in no group.
            BookingResult.PeakHoursPriorityOnly p => Results.Conflict(
                new
                {
                    error,
                    peak_start = p.PeakStart,
                    peak_end = p.PeakEnd,
                    regular_advance_hours = p.RegularAdvanceHours,
                    withheld_by_groups = p.WithheldByGroups,
                }),
            // The minutes cap — blueprint A.4's. The three original figures are unchanged so no
            // existing client breaks; the three new ones are what the member's sentence needs, and
            // resets_at is here so a browser never has to compute a club midnight (which is D2-B33
            // waiting to happen on the other side of the wire).
            BookingResult.PerDayCapExceeded c => Results.Conflict(
                new
                {
                    error,
                    cap_minutes = c.CapMinutes,
                    already_booked_minutes = c.AlreadyBookedMinutes,
                    attempted_minutes = c.AttemptedMinutes,
                    bound_by = c.BoundByGroupName is null ? "tenant" : "group",
                    group_name = c.BoundByGroupName,
                    club_day = c.ClubDay,
                    resets_at = c.ResetsAt,
                }),
            // GOAL item 19's cap, in SLOTS. Every figure the sentence needs, so the client composes
            // "You have used all 4 of your slots for Tuesday. They reset at midnight." from one
            // response. relaxation_available is the difference between "come back tomorrow" and
            // "there is a court free at 19:00 if you want it".
            BookingResult.PerDaySlotCapExceeded c => Results.Conflict(
                new
                {
                    error,
                    cap_slots = c.CapSlots,
                    booked_slots = c.BookedSlots,
                    attempted_slots = c.AttemptedSlots,
                    remaining_slots = c.RemainingSlots,
                    bound_by = c.BoundByGroupName is null ? "tenant" : "group",
                    group_name = c.BoundByGroupName,
                    club_day = c.ClubDay,
                    resets_at = c.ResetsAt,
                    relaxation_available = c.RelaxationAvailable,
                }),
            // GOAL item 3. The windows the member MAY book in travel with the refusal, because "not
            // now" without "then" is a refusal a technology-averse member cannot act on.
            BookingResult.GroupWindow w => Results.Conflict(
                new
                {
                    error,
                    groups = w.GroupNames,
                    // The round-1 contract's name for the same fact, joined for a sentence.
                    group_name = string.Join(", ", w.GroupNames),
                    day = w.Day,
                    allowed_windows = w.AllowedWindows.Select(x => new { start = x.Start, end = x.End }).ToList(),
                }),
            // The booking runs past the end of the club's day. Its own code, because every other
            // refusal available here describes it wrongly — see BookingResult.CrossesMidnight.
            BookingResult.CrossesMidnight m => Results.Conflict(
                new
                {
                    error,
                    starts_at = m.StartsAt,
                    ends_at = m.EndsAt,
                    minutes_past_midnight = m.MinutesPastMidnight,
                }),
            // The member is in two or more groups whose windows do not overlap at all on this day,
            // so there is nothing they can book. Its own code, because the honest sentence is
            // completely different and because an empty grid reads as "the club is shut".
            BookingResult.NoBookableWindow n => Results.Conflict(
                new { error, groups = n.GroupNames, group_name = string.Join(", ", n.GroupNames), day = n.Day }),
            BookingResult.OutOfHours h => Results.Conflict(
                new { error, opens_at = h.OpensAt, closes_at = h.ClosesAt }),
            BookingResult.NoTimeAvailable n => Results.Conflict(
                new { error, requested_minutes = n.RequestedMinutes, available_minutes = n.AvailableMinutes }),
            BookingResult.InvalidDuration id => Results.BadRequest(
                new { error, requested_slices = id.RequestedSlices, max_slices = id.MaxSlices }),
            BookingResult.DuplicateRequest => Results.Conflict(new { error }),
            _ => Unmapped(result, ctx),
        };
    }

    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch or an
    // object initialiser as the END of the function and dumps the rest of the file into a
    // *global* pseudo-function whose length trips `-L 200`. See memory/gotchas.md and
    // whitelizard.txt's header.
    private static IResult ToHttpResult(CancellationResult result, HttpContext ctx)
    {
        return result switch
        {
            CancellationResult.Ok ok => Results.Ok(new { refunded_credits = ok.RefundedCredits, penalty_credits = ok.PenaltyCredits }),
            CancellationResult.NotFound => Results.NotFound(new { error = "booking_not_found" }),
            CancellationResult.AlreadyStarted => Results.BadRequest(new { error = "already_started" }),
            _ => Unmapped(result, ctx),
        };
    }

    /// <summary>
    /// The member's cancellation quote, with what the partners get back and what the organiser
    /// keeps (review round 1, B3 — see <see cref="SplitCancelView"/>).
    /// </summary>
    private static async Task<IResult> MemberCancelQuoteAsync(
        Guid bookingId, HttpContext ctx, BookingService svc, MainframeDbContext db, SplitCancelView split, CancellationToken ct)
    {
        var actorId = ctx.User.Id() ?? Guid.Empty;
        var quote = await svc.QuoteCancellationAsync(bookingId, actorId, actorIsAdmin: ctx.User.IsInRole("admin"), ct);
        if (quote is null) return Results.NotFound(new { error = "booking_not_found" });

        var booking = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == bookingId, ct);
        var refunds = await split.QuoteAsync(booking, quote.RefundCredits, ct);
        return Results.Ok(quote with { NetCredits = quote.RefundCredits - refunds.Sum(r => r.Credits), PartnerRefunds = refunds });
    }

    /// <summary>
    /// The member's cancellation. D11: the organiser's refund moved Owed, and each partner's share
    /// follows it — so the answer names each partner's refund and the organiser's net (B3).
    /// </summary>
    private static async Task<IResult> MemberCancelAsync(Guid bookingId, HttpContext ctx, BookingService svc, SplitCancelView split, CancellationToken ct)
    {
        var actorId = ctx.User.Id() ?? Guid.Empty;
        var paidBefore = await split.PaidByPartnerAsync(bookingId, ct);
        var result = await svc.CancelAsync(bookingId, actorId, actorIsAdmin: false, waivePenalty: false, ct);
        if (result is not CancellationResult.Ok ok) return ToHttpResult(result, ctx);

        await ctx.AfterSettlementAsync([bookingId], ct);
        return CancelledAnswer(ok, await split.AfterAsync(bookingId, paidBefore, ct));
    }

    /// <summary>
    /// The arm that should never run. It answers 500 as before — but it LOGS, naming the
    /// type it could not map, so the next unmapped result is found by reading the log
    /// rather than by a member reporting that booking is broken.
    /// </summary>
    private static IResult Unmapped(object result, HttpContext ctx)
    {
        ctx.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger(typeof(BookingEndpoints))
            .LogError("Booking endpoint has no HTTP mapping for result type {ResultType}", result.GetType().FullName);
        return Results.Problem("Unexpected");
    }
}

public sealed record CreateBlockRequest(Guid CourtId, DateTimeOffset StartsAt, int SliceCount, string? Label);
/// <summary>
/// A member's booking. <paramref name="Players"/>, <paramref name="SplitMode"/> and
/// <paramref name="OrganiserWeight"/> are D11's optional players payload — omitted, the booking is
/// "just me", exactly as before.
/// </summary>
public sealed record CreateBookingRequest(
    Guid CourtId, DateTimeOffset StartsAt, int SliceCount,
    IReadOnlyList<PlayerSpec>? Players = null, string? SplitMode = null, int? OrganiserWeight = null);
/// <summary>
/// <paramref name="AllowNegativeBalance"/> is §8's admin override, and it is deliberately
/// absent from <see cref="CreateBookingRequest"/>: a member cannot ask to be overdrawn. An
/// admin may point it at their OWN wallet through this record (decision R19, 2026-09-23) —
/// that is how an admin books themselves into the red, on the record. Defaulted so an older
/// client that does not send the field books exactly as it did before.
/// </summary>
public sealed record AdminBookingRequest(
    Guid CourtId, Guid UserId, DateTimeOffset StartsAt, int SliceCount, bool AllowNegativeBalance = false);
/// <summary>
/// <paramref name="WaiveReason"/> is required whenever <paramref name="WaivePenalty"/> is
/// true — §7's "logged with reason". Defaulted so a cancellation that waives nothing needs
/// no reason, and so an older client that never waives is unaffected.
/// </summary>
/// <summary>
/// The desk's cancellation. <c>reason</c> is required (review round 4, A4-4 —
/// <c>400 reason_required</c>); <c>waiveReason</c> is accepted in its place.
/// </summary>
public sealed record AdminCancelRequest(bool WaivePenalty = false, string? WaiveReason = null, string? Reason = null);

/// <summary>
/// The query of <c>GET /api/v1/admin/bookings/quote</c>, as sent. <c>userId</c> is the payer and
/// defaults to the calling admin; the slice count is <c>slices</c> or — the booking POST's own
/// word — <c>sliceCount</c>.
///
/// <para>
/// <b>Strings, parsed by hand, under both spellings.</b> Typed parameters answered a 400 with an
/// EMPTY body for <c>?sliceCount=1</c> (the POST's name for the same number) and for snake_case
/// <c>court_id</c>, where every other refusal in this API is an <c>{error}</c> the console maps to
/// a sentence. The bulk quote already binds both spellings for the reason <c>AdjustRequest</c>
/// documents; this is the same promise for the single quote.
/// </para>
/// </summary>
public sealed record AdminQuoteQuery(
    string? UserId = null, string? CourtId = null, string? StartsAt = null,
    string? Slices = null, string? SliceCount = null,
    [Microsoft.AspNetCore.Mvc.FromQuery(Name = "user_id")] string? UserIdSnake = null,
    [Microsoft.AspNetCore.Mvc.FromQuery(Name = "court_id")] string? CourtIdSnake = null,
    [Microsoft.AspNetCore.Mvc.FromQuery(Name = "starts_at")] string? StartsAtSnake = null,
    [Microsoft.AspNetCore.Mvc.FromQuery(Name = "slice_count")] string? SliceCountSnake = null)
{
    /// <summary>The query, parsed — or null when anything required is missing or malformed.</summary>
    public ParsedAdminQuote? Parse()
    {
        var user = UserId ?? UserIdSnake;
        Guid? userId = null;
        if (user is not null)
        {
            if (!Guid.TryParse(user, out var parsedUser)) return null;
            userId = parsedUser;
        }

        var ok = Guid.TryParse(CourtId ?? CourtIdSnake, out var courtId)
                 // Normalised to UTC here, the query-string twin of UtcInstantConverter (review
                 // round 3, A-1): a console in the club's zone sends `+02:00`, and that offset
                 // reached the overlap query, where Npgsql refuses it.
                 & DateTimeOffset.TryParse(StartsAt ?? StartsAtSnake,
                     System.Globalization.CultureInfo.InvariantCulture,
                     System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                     out var startsAt)
                 & int.TryParse(Slices ?? SliceCount ?? SliceCountSnake,
                     System.Globalization.NumberStyles.Integer,
                     System.Globalization.CultureInfo.InvariantCulture, out var slices);
        return ok ? new ParsedAdminQuote(userId, courtId, startsAt, slices) : null;
    }
}

/// <summary>A well-formed <see cref="AdminQuoteQuery"/>.</summary>
public sealed record ParsedAdminQuote(Guid? UserId, Guid CourtId, DateTimeOffset StartsAt, int Slices);
