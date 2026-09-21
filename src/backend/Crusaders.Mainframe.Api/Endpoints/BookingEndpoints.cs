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
        var g = app.MapGroup("/api/v1/bookings").RequireAuthorization();

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
            var result = await svc.CreateAsync(req.CourtId, payer, req.StartsAt, req.SliceCount, ct);
            return ToHttpResult(result, ctx);
        });

        g.MapGet("/{bookingId:guid}/cancellation-quote", async (Guid bookingId, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var quote = await svc.QuoteCancellationAsync(bookingId, actorId, actorIsAdmin: ctx.User.IsInRole("admin"), ct);
            return quote is null ? Results.NotFound(new { error = "booking_not_found" }) : Results.Ok(quote);
        });

        g.MapPost("/{bookingId:guid}/cancel", async (Guid bookingId, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CancelAsync(bookingId, actorId, actorIsAdmin: false, waivePenalty: false, ct);
            return ToHttpResult(result, ctx);
        });

        // Admin: book on behalf + cancel-with-waive
        var admin = app.MapGroup("/api/v1/admin/bookings").RequireAuthorization(p => p.RequireRole("admin"));

        // §8: "Book on behalf of any member (charges that member's credit; if insufficient,
        // admin can override and create a negative balance, logged)."
        //
        // `allowNegativeBalance` is the override, and it exists on THIS request record and
        // not on the member's own — a member has no way to send it, and the service refuses
        // it anyway unless the actor differs from the payer. The desk is expected to see the
        // ordinary 402 first, with the member's balance and the price in it, and to come
        // back having read them; nothing here makes the overdraft the default.
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
        var reason = req?.WaiveReason?.Trim();
        if (waive && string.IsNullOrEmpty(reason))
            return Results.BadRequest(new { error = "waive_reason_required" });

        var result = await svc.CancelAsync(bookingId, actorId, actorIsAdmin: true, waivePenalty: waive, ct, reason);
        return ToHttpResult(result, ctx);
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
    private static IResult ToHttpResult(BookingResult result, HttpContext ctx)
    {
        return result switch
        {
        BookingResult.Ok ok => Results.Ok(new { booking_id = ok.Booking.Id, balance_after_credits = ok.BalanceAfterCredits }),
        BookingResult.NotFound => Results.NotFound(new { error = "court_not_found" }),
        BookingResult.PastTime => Results.BadRequest(new { error = "past_time" }),
        BookingResult.TooFarAhead => Results.BadRequest(new { error = "too_far_ahead" }),
        BookingResult.SlotTaken => Results.Conflict(new { error = "slot_taken" }),
        BookingResult.InsufficientBalance ib => Results.Json(
            new { error = "insufficient_balance", current_credits = ib.CurrentCredits, required_credits = ib.RequiredCredits }, statusCode: 402),
        BookingResult.PeakHoursLeagueOnly p => Results.Conflict(
            new { error = "peak_hours_league_only", peak_start = p.PeakStart, peak_end = p.PeakEnd, regular_advance_hours = p.RegularAdvanceHours }),
        // The minutes cap — blueprint A.4's. The three original figures are unchanged so no
        // existing client breaks; the three new ones are what the member's sentence needs, and
        // resets_at is here so a browser never has to compute a club midnight (which is D2-B33
        // waiting to happen on the other side of the wire).
        BookingResult.PerDayCapExceeded c => Results.Conflict(
            new
            {
                error = "per_day_cap_exceeded",
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
                error = "per_day_slot_cap_exceeded",
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
                error = "group_window",
                groups = w.GroupNames,
                day = w.Day,
                allowed_windows = w.AllowedWindows.Select(x => new { start = x.Start, end = x.End }).ToList(),
            }),
        // The member is in two or more groups whose windows do not overlap at all on this day,
        // so there is nothing they can book. Its own code, because the honest sentence is
        // completely different and because an empty grid reads as "the club is shut".
        BookingResult.NoBookableWindow n => Results.Conflict(
            new { error = "no_bookable_window", groups = n.GroupNames, day = n.Day }),
        BookingResult.OutOfHours h => Results.Conflict(
            new { error = "out_of_hours", opens_at = h.OpensAt, closes_at = h.ClosesAt }),
        BookingResult.NoTimeAvailable n => Results.Conflict(
            new { error = "no_time_available", requested_minutes = n.RequestedMinutes, available_minutes = n.AvailableMinutes }),
        BookingResult.InvalidDuration id => Results.BadRequest(
            new { error = "invalid_duration", requested_slices = id.RequestedSlices, max_slices = id.MaxSlices }),
        BookingResult.DuplicateRequest => Results.Conflict(new { error = "duplicate_request" }),
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
public sealed record CreateBookingRequest(Guid CourtId, DateTimeOffset StartsAt, int SliceCount);
/// <summary>
/// <paramref name="AllowNegativeBalance"/> is §8's admin override, and it is deliberately
/// absent from <see cref="CreateBookingRequest"/>: a member cannot ask to be overdrawn, and
/// an admin booking for themselves gets no benefit from it either, because the service only
/// honours it when the actor and the payer differ. Defaulted so an older client that does
/// not send the field books exactly as it did before.
/// </summary>
public sealed record AdminBookingRequest(
    Guid CourtId, Guid UserId, DateTimeOffset StartsAt, int SliceCount, bool AllowNegativeBalance = false);
/// <summary>
/// <paramref name="WaiveReason"/> is required whenever <paramref name="WaivePenalty"/> is
/// true — §7's "logged with reason". Defaulted so a cancellation that waives nothing needs
/// no reason, and so an older client that never waives is unaffected.
/// </summary>
public sealed record AdminCancelRequest(bool WaivePenalty, string? WaiveReason = null);
