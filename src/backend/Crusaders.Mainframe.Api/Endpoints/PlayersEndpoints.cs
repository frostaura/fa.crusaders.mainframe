using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// D11–D13 — the players on a booking and who pays what; invites and links; recent partners,
/// favourites and the opt-in directory; and the admin's god mode over all of it. The rules are
/// in <see cref="PlayersService"/>, <see cref="ShareLedger"/> and <see cref="PlayersQuery"/>;
/// this file is routes. The full request/response catalogue is <c>docs/specs/players-and-splits.md</c>.
///
/// <para>
/// <b>Requests are camelCase and answers snake_case</b>, as every POST in this API is. A refusal
/// is always <c>{ error, …figures }</c> with a stable code the client maps to a sentence.
/// </para>
/// </summary>
public static class PlayersEndpoints
{
    public static IEndpointRouteBuilder MapPlayersEndpoints(this IEndpointRouteBuilder app)
    {
        // Reads: bounded by the global per-IP limiter, like every other read.
        var reads = app.MapGroup("/api/v1").RequireAuthorization();
        reads.MapGet("/bookings/{bookingId:guid}", DetailAsync);
        reads.MapGet("/me/invites", InvitesAsync);
        reads.MapGet("/invites/{token}", InviteAsync);
        reads.MapGet("/me/partners/recent", RecentAsync);
        reads.MapGet("/me/partners/favourites", FavouritesAsync);
        reads.MapGet("/members/directory", DirectoryAsync);
        reads.MapPost("/players/split-preview", SplitPreview);

        // Writes: the `auth` limiter, as the booking routes they sit beside.
        var writes = app.MapGroup("/api/v1").RequireAuthorization().RequireRateLimiting(RateLimitPolicies.Auth);
        writes.MapPost("/bookings/{bookingId:guid}/players", AddAsync);
        writes.MapDelete("/bookings/{bookingId:guid}/players/{participantId:guid}", RemoveAsync);
        writes.MapPost("/bookings/{bookingId:guid}/players/{participantId:guid}/nudge", NudgeAsync);
        writes.MapPost("/bookings/{bookingId:guid}/players/{participantId:guid}/link", LinkAsync);
        writes.MapPut("/bookings/{bookingId:guid}/split", SplitAsync);
        writes.MapPost("/bookings/{bookingId:guid}/players/{participantId:guid}/accept", AcceptAsync);
        writes.MapPost("/bookings/{bookingId:guid}/players/{participantId:guid}/decline", DeclineAsync);
        writes.MapPost("/bookings/{bookingId:guid}/players/{participantId:guid}/withdraw", WithdrawAsync);
        writes.MapPost("/invites/{token}/accept", AcceptLinkAsync);
        writes.MapPost("/invites/{token}/decline", DeclineLinkAsync);
        writes.MapPut("/me/partners/favourites/{userId:guid}", StarAsync);
        writes.MapDelete("/me/partners/favourites/{userId:guid}", UnstarAsync);

        var admin = app.MapGroup("/api/v1/admin/bookings/{bookingId:guid}/players")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .RequireRateLimiting(RateLimitPolicies.Auth);
        admin.MapPost("/", AdminAddAsync);
        admin.MapPost("/{participantId:guid}/remove", (Guid bookingId, Guid participantId, AdminPlayerRequest? req, HttpContext ctx, PlayersAdminService svc, CancellationToken ct) =>
            Run(svc.RemoveAsync(Act(bookingId, participantId, ctx, req), ct)));
        admin.MapPost("/{participantId:guid}/accept", (Guid bookingId, Guid participantId, AdminPlayerRequest? req, HttpContext ctx, PlayersAdminService svc, CancellationToken ct) =>
            Run(svc.AcceptOnBehalfAsync(Act(bookingId, participantId, ctx, req), ct)));
        admin.MapPost("/{participantId:guid}/settle-outside", (Guid bookingId, Guid participantId, AdminPlayerRequest? req, HttpContext ctx, PlayersAdminService svc, CancellationToken ct) =>
            Run(svc.SettleOutsideAsync(Act(bookingId, participantId, ctx, req), ct)));
        admin.MapPost("/{participantId:guid}/collect", (Guid bookingId, Guid participantId, AdminPlayerRequest? req, HttpContext ctx, PlayersAdminService svc, CancellationToken ct) =>
            Run(svc.CollectAsync(Act(bookingId, participantId, ctx, req), req?.AllowNegativeBalance ?? false, ct)));

        return app;
    }

    // ------------------------------------------------------------------ reads

    private static async Task<IResult> DetailAsync(Guid bookingId, HttpContext ctx, PlayersQuery query, CancellationToken ct)
    {
        var view = await query.DetailAsync(bookingId, Me(ctx), ctx.User.IsInRole("admin"), ct);
        return view is null ? Results.NotFound(new { error = "booking_not_found" }) : Results.Ok(view);
    }

    private static async Task<IResult> InvitesAsync(HttpContext ctx, PlayersQuery query, CancellationToken ct)
    {
        var items = await query.InvitesAsync(Me(ctx), ct);
        return Results.Ok(new { items, count = items.Count });
    }

    /// <summary>
    /// Opening a shared link (<c>/j/{token}</c>). A link addressed to another member is a 404 —
    /// the same answer as a token that names nothing — so a forwarded link reveals no game.
    /// </summary>
    private static async Task<IResult> InviteAsync(
        string token, HttpContext ctx, PlayersService players, PlayersQuery query, [AsParameters] InviteDeps deps, CancellationToken ct)
    {
        var me = Me(ctx);
        var seat = await players.SeatForTokenAsync(token, ct);
        if (seat is null || (seat.UserId is { } owner && owner != me)) return Results.NotFound(new { error = "invite_not_found" });

        var booking = await deps.Db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == seat.BookingId, ct);
        if (booking?.UserId is null) return Results.NotFound(new { error = "invite_not_found" });
        if (booking.UserId == me) return Results.Conflict(new { error = PlayerErrors.AlreadyInBooking, booking_id = booking.Id });
        if (await deps.Db.BookingParticipants.AsNoTracking()
                .AnyAsync(p => p.BookingId == booking.Id && p.UserId == me && p.Status == ParticipantStatus.Removed, ct))
        {
            // Taken off this game: the link shows them nothing to accept (the accept refuses too).
            return Results.Conflict(new { error = PlayerErrors.PreviouslyRemoved, booking_id = booking.Id });
        }

        var settings = await deps.Settings.GetAsync(ct);
        var closed = !seat.IsLive || booking.Status is not (BookingStatus.Booked or BookingStatus.Completed)
                     || DateTimeOffset.UtcNow >= PlayerSettings.ShareDeadline(booking, settings);
        if (closed) return Results.Conflict(new { error = PlayerErrors.InviteClosed, booking_id = booking.Id });

        return Results.Ok(await query.InviteViewAsync(booking, seat, me, settings, ct));
    }

    public sealed record DirectoryDeps(TenantSettingsAccessor Settings, DirectoryRateLimiter Limiter, ITenantContext Tenant);

    public sealed record InviteDeps(MainframeDbContext Db, TenantSettingsAccessor Settings);

    // Block bodies for the lizard reason in memory/gotchas-build.md: an expression body carrying
    // `new { … }` reads to lizard as the end of the function and the rest of the file as *global*.
    private static async Task<IResult> RecentAsync(HttpContext ctx, PlayersQuery query, CancellationToken ct)
    {
        return Results.Ok(new { items = await query.RecentAsync(Me(ctx), ct) });
    }

    private static async Task<IResult> FavouritesAsync(HttpContext ctx, PlayersQuery query, CancellationToken ct)
    {
        return Results.Ok(new { items = await query.FavouritesAsync(Me(ctx), ct) });
    }

    /// <summary>
    /// D13's directory: opted-in active members only, two characters at least, and a per-member
    /// budget a minute (<c>directory_searches_per_minute</c>) — a directory is a scraping surface.
    /// </summary>
    private static async Task<IResult> DirectoryAsync(
        string? q, HttpContext ctx, PlayersQuery query, [AsParameters] DirectoryDeps deps, CancellationToken ct)
    {
        var (settings, limiter, tenant) = (deps.Settings, deps.Limiter, deps.Tenant);
        var term = q?.Trim() ?? "";
        if (term.Length < PlayersQuery.MinQueryLength || term.Length > 64)
        {
            return Results.BadRequest(new { error = "query_too_short", min_length = PlayersQuery.MinQueryLength });
        }

        var budget = PlayerSettings.DirectorySearchesPerMinute(await settings.GetAsync(ct));
        var (allowed, retry) = limiter.TryAcquire(tenant.TenantId, Me(ctx), budget, DateTimeOffset.UtcNow);
        if (!allowed)
        {
            return Results.Json(new { error = "directory_rate_limited", retry_after_seconds = (int)Math.Ceiling(retry.TotalSeconds) }, statusCode: 429);
        }

        var members = await query.DirectoryAsync(Me(ctx), term, ct);
        return Results.Ok(new { items = members.Select(m => new { user_id = m.UserId, name = m.Name, photo_url = m.PhotoUrl }) });
    }

    /// <summary>
    /// The BookSheet's live totals bar: how a price would split, before anything is booked. Pure —
    /// the calculator the booking itself uses, with nothing read or written.
    /// </summary>
    private static IResult SplitPreview(SplitPreviewRequest req)
    {
        var specs = req.Players ?? [];
        if (req.PriceCredits is not { } price || price < 0 || specs.Count > BookingParticipant.MaxSeats - 1)
        {
            return Results.BadRequest(new { error = "split_preview_invalid" });
        }
        var seats = PlayersService.PlanSeats(specs, [1]);
        if (seats is null) return Results.Conflict(new { error = PlayerErrors.SeatTaken });

        var inputs = new List<SplitSeat> { new(1, false, req.OrganiserWeight ?? 1) };
        inputs.AddRange(specs.Select((s, i) => new SplitSeat(seats[i], s.GuestName is not null, s.Weight ?? 1, s.Amount ?? 0m)));
        var split = SplitCalculator.Split(price, req.SplitMode ?? SplitModes.Equal, inputs);
        if (split.Error is { } error) return Results.BadRequest(new { error });
        return Results.Ok(new
        {
            price_credits = price,
            shares = split.Shares!.Select(s => new { seat = s.Seat, team = PlayerViews.TeamOf(s.Seat), share_credits = s.ShareCredits, weight = s.Weight }),
        });
    }

    // ------------------------------------------------------------------ writes

    private static async Task<IResult> AddAsync(
        Guid bookingId, PlayersRequest req, HttpContext ctx, PlayersService players, MainframeDbContext db, CancellationToken ct)
    {
        if (await BookingMembershipGate.RefuseIfBarredAsync(db, Me(ctx), ct) is { } barred) return barred;
        return ToResult(await players.AddAsync(bookingId, Me(ctx), req, ct));
    }

    private static Task<IResult> RemoveAsync(Guid bookingId, Guid participantId, HttpContext ctx, PlayersService players, CancellationToken ct) =>
        Run(players.RemoveAsync(bookingId, participantId, Me(ctx), ct));

    private static Task<IResult> NudgeAsync(Guid bookingId, Guid participantId, HttpContext ctx, PlayersService players, CancellationToken ct) =>
        Run(players.NudgeAsync(bookingId, participantId, Me(ctx), ct));

    private static Task<IResult> LinkAsync(Guid bookingId, Guid participantId, HttpContext ctx, PlayersService players, CancellationToken ct) =>
        Run(players.RotateLinkAsync(bookingId, participantId, Me(ctx), ct));

    private static Task<IResult> SplitAsync(Guid bookingId, SplitRequest req, HttpContext ctx, PlayersService players, CancellationToken ct) =>
        Run(players.ChangeSplitAsync(bookingId, Me(ctx), req, ct));

    /// <summary>
    /// The seat must be on the booking in the path — an id from another booking is a 404, not an
    /// accept. The body names the share the partner was shown (<c>expectedShareCredits</c>).
    /// </summary>
    private static async Task<IResult> AcceptAsync(
        Guid bookingId, Guid participantId, AcceptRequest? req, HttpContext ctx, [AsParameters] SeatDeps deps, CancellationToken ct)
    {
        if (!await SeatOnAsync(deps.Db, bookingId, participantId, ct)) return Results.NotFound(new { error = "invite_not_found" });
        return ToResult(await deps.Players.AcceptAsync(participantId, Me(ctx), req?.ExpectedShareCredits, ct));
    }

    /// <summary>The accept route's services, bound as one parameter for the complexity gate.</summary>
    public sealed record SeatDeps(PlayersService Players, MainframeDbContext Db);

    private static async Task<IResult> DeclineAsync(
        Guid bookingId, Guid participantId, HttpContext ctx, PlayersService players, MainframeDbContext db, CancellationToken ct)
    {
        if (!await SeatOnAsync(db, bookingId, participantId, ct)) return Results.NotFound(new { error = "invite_not_found" });
        return ToResult(await players.DeclineAsync(participantId, Me(ctx), ct));
    }

    private static async Task<IResult> WithdrawAsync(
        Guid bookingId, Guid participantId, HttpContext ctx, PlayersService players, MainframeDbContext db, CancellationToken ct)
    {
        if (!await SeatOnAsync(db, bookingId, participantId, ct)) return Results.NotFound(new { error = "player_not_found" });
        return ToResult(await players.WithdrawAsync(participantId, Me(ctx), ct));
    }

    private static Task<IResult> AcceptLinkAsync(string token, AcceptRequest? req, HttpContext ctx, PlayersService players, CancellationToken ct) =>
        Run(players.AcceptByTokenAsync(token, Me(ctx), req?.ExpectedShareCredits, ct));

    private static async Task<IResult> DeclineLinkAsync(string token, HttpContext ctx, PlayersService players, CancellationToken ct)
    {
        var seat = await players.SeatForTokenAsync(token, ct);
        if (seat is null || seat.UserId != Me(ctx)) return Results.NotFound(new { error = "invite_not_found" });
        return ToResult(await players.DeclineAsync(seat.Id, Me(ctx), ct));
    }

    private static Task<bool> SeatOnAsync(MainframeDbContext db, Guid bookingId, Guid participantId, CancellationToken ct) =>
        db.BookingParticipants.AsNoTracking().AnyAsync(p => p.Id == participantId && p.BookingId == bookingId, ct);

    /// <summary>Stars a member. Idempotent; active members of this club only, never oneself.</summary>
    private static async Task<IResult> StarAsync(
        Guid userId, HttpContext ctx, MainframeDbContext db, PlayersQuery query, ITenantContext tenant, CancellationToken ct)
    {
        var me = Me(ctx);
        if (userId == me) return Results.BadRequest(new { error = "cannot_favourite_self" });
        if (!(await query.ActiveMembersAsync([userId], ct)).ContainsKey(userId)) return Results.NotFound(new { error = PlayerErrors.MemberNotFound });
        if (!await db.PartnerFavourites.AnyAsync(f => f.UserId == me && f.PartnerUserId == userId, ct))
        {
            db.PartnerFavourites.Add(new PartnerFavourite { TenantId = tenant.TenantId, UserId = me, PartnerUserId = userId, CreatedAt = StorableTime.UtcNow });
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                // A double tap; the index kept one.
            }
        }
        return Results.Ok(new { user_id = userId, favourite = true });
    }

    private static async Task<IResult> UnstarAsync(Guid userId, HttpContext ctx, MainframeDbContext db, CancellationToken ct)
    {
        var me = Me(ctx);
        await db.PartnerFavourites.Where(f => f.UserId == me && f.PartnerUserId == userId).ExecuteDeleteAsync(ct);
        return Results.Ok(new { user_id = userId, favourite = false });
    }

    private static async Task<IResult> AdminAddAsync(
        Guid bookingId, AdminAddPlayerRequest req, HttpContext ctx, PlayersAdminService svc, CancellationToken ct)
    {
        var spec = new PlayerSpec(UserId: req.UserId, GuestName: req.GuestName, Link: req.UserId is null && req.GuestName is null ? true : null);
        return ToResult(await svc.AddAsync(new PlayersAdminService.AdminAct(bookingId, null, Me(ctx), req.Reason), spec, req.Accepted, ct));
    }

    // ------------------------------------------------------------------ plumbing

    private static Guid Me(HttpContext ctx) => ctx.User.Id() ?? Guid.Empty;

    private static PlayersAdminService.AdminAct Act(Guid bookingId, Guid participantId, HttpContext ctx, AdminPlayerRequest? req) =>
        new(bookingId, participantId, Me(ctx), req?.Reason, req?.AllowNegativeBalance ?? false);

    private static async Task<IResult> Run(Task<PlayerOutcome> outcome) => ToResult(await outcome);

    /// <summary>
    /// A players answer as HTTP: the body on success; on refusal <c>{ error, …figures }</c>, the
    /// figures folded in beside the code so the client reads one flat object, as every booking
    /// refusal in this API already is.
    /// </summary>
    internal static IResult ToResult(PlayerOutcome outcome)
    {
        if (outcome.IsOk) return Results.Json(outcome.Body, statusCode: outcome.StatusCode);

        var body = new Dictionary<string, object?> { ["error"] = outcome.Error };
        if (outcome.Body is not null)
        {
            foreach (var p in JsonSerializer.SerializeToElement(outcome.Body).EnumerateObject()) body[p.Name] = p.Value;
        }
        return Results.Json(body, statusCode: outcome.StatusCode);
    }
}

/// <summary>A split to preview: the price, the mode, and the players as the BookSheet holds them.</summary>
public sealed record SplitPreviewRequest(
    decimal? PriceCredits = null, string? SplitMode = null, int? OrganiserWeight = null, IReadOnlyList<PlayerSpec>? Players = null);

/// <summary>An admin adding a player: a member (invited, or placed with <c>accepted</c>), a guest, or an open link seat.</summary>
public sealed record AdminAddPlayerRequest(Guid? UserId = null, string? GuestName = null, bool Accepted = false, string? Reason = null);

/// <summary>
/// A partner's accept: the share they were shown on the accept sheet. Required — a share that has
/// risen past it since is refused with <c>409 share_changed</c> and the current figure.
/// </summary>
public sealed record AcceptRequest(decimal? ExpectedShareCredits = null);

/// <summary>
/// An admin acting on one seat. The reason is required. The overdraft flag is required on a
/// collect, and on a remove or settle-outside after the share deadline (the hand-back is then no
/// longer covered by the organiser's hold).
/// </summary>
public sealed record AdminPlayerRequest(string? Reason = null, bool AllowNegativeBalance = false);
