using System.Text.Json;
using System.Threading.Channels;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class WalletEndpoints
{
    public static IEndpointRouteBuilder MapWalletEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1").RequireAuthorization();

        // limit/offset are bounded rather than optional. This returned EVERY ledger row the
        // member had ever had — DateTimeOffset.MinValue to now+1d with no Take — which is
        // fine at 32 rows and is three years of movements on a page a member opens on a
        // phone while arguing about their balance. The balance itself is still the full sum,
        // never the sum of the page.
        g.MapGet("/wallet", async (int? limit, int? offset, HttpContext ctx, LedgerService ledger, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var take = Math.Clamp(limit ?? 100, 1, 500);
            var skip = Math.Max(offset ?? 0, 0);
            var balance = await ledger.GetBalanceAsync(userId, ct);
            var total = await db.LedgerEntries.CountAsync(l => l.UserId == userId, ct);
            var entries = await ledger.GetEntriesAsync(userId, DateTimeOffset.MinValue, DateTimeOffset.UtcNow.AddDays(1), ct, skip, take);

            // Resolve display names so rows read with the same from/to/amount/time/comment shape
            // as the admin ledger.
            var ids = entries.Select(e => e.UserId).Concat(entries.Select(e => e.ActorUserId)).Distinct().ToList();
            var nameByUserId = await db.Memberships.AsNoTracking().IgnoreQueryFilters()
                .Where(m => ids.Contains(m.UserId))
                .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);
            var emailByUserId = await db.Users.AsNoTracking().IgnoreQueryFilters()
                .Where(u2 => ids.Contains(u2.Id))
                .ToDictionaryAsync(u2 => u2.Id, u2 => u2.Email, ct);
            string nameFor(Guid id) => nameByUserId.TryGetValue(id, out var n) ? n
                : emailByUserId.TryGetValue(id, out var em) ? em
                : "(unknown)";

            var rows = entries.Select(e => LedgerRowMapper.Build(e, nameFor)).ToList();

            return Results.Ok(new
            {
                balance_credits = balance,
                entries = rows,
                total_entries = total,
                offset = skip,
                limit = take,
            });
        });

        // Mints the credential the SSE stream is opened with.
        //
        // EventSource cannot set an Authorization header, so whatever authenticates the stream has
        // to ride in the URL — and nginx's `location /api/` logs `$request`, query string included,
        // on every connect and every reconnect. The full access token used to travel there: a
        // fifteen-minute credential for the entire API, written to a log file that outlives it by
        // months. This ticket is minted by a POST (never logged), lives one minute, and is refused
        // on every path but the stream itself.
        g.MapPost("/wallet/stream-ticket", MintStreamTicket);

        // Server-Sent Events stream of the current user's balance. Pushes the latest balance
        // whenever any ledger entry posts for this user. Used by the BalanceProvider on the
        // client so admin top-ups land in the member's session without a reload.
        g.MapGet("/wallet/stream", StreamAsync);

        // Admin: manual credit adjustment
        // The one route in the API that moves money by hand, and the only limiter on it was the
        // global 600/min per IP. A desk that can be scripted is a desk that can be drained.
        var admin = app.MapGroup("/api/v1/admin/credit")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .RequireRateLimiting(Security.RateLimitPolicies.Auth);

        // The handler is a named method rather than an inline lambda: it is the most
        // consequential route in this file - it moves a member's balance by hand - and
        // inline it pushed MapWalletEndpoints past the complexity gate, where the reported
        // number belongs to no single decision anybody could reason about.
        admin.MapPost("/{userId:guid}/adjust", AdjustAsync);

        return app;
    }

    /// <summary>
    /// The member's own live balance, as Server-Sent Events.
    ///
    /// <para>
    /// A named method rather than an inline lambda for the reason the adjust handler already
    /// gives: lizard scores the whole <c>MapWalletEndpoints</c> registration as one function, so
    /// a handler's branches are charged to the registration.
    /// </para>
    ///
    /// <para>
    /// <b>Two frames per movement.</b> <see cref="LedgerService"/> publishes the legacy unnamed
    /// <c>data:</c> frame that today's client listens for as <c>message</c>, and a named
    /// <c>balance</c> frame carrying <c>delta_credits</c> and <c>reason</c> beside it. The
    /// stream itself is a transport and does not know the difference: it writes whatever the bus
    /// hands it, so a third frame shape costs nothing here.
    /// </para>
    ///
    /// <para>
    /// The opening frame is still the plain balance, because a client that has just connected
    /// has no delta to animate — it has a number to show.
    /// </para>
    /// </summary>
    private static async Task StreamAsync(
        HttpContext ctx,
        LedgerService ledger,
        IRealtimeBus bus,
        ITenantContext tenant,
        TenantSettingsAccessor settings,
        CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) { ctx.Response.StatusCode = 401; return; }

        ctx.Response.Headers["Content-Type"] = "text/event-stream";
        ctx.Response.Headers["Cache-Control"] = "no-cache, no-transform";
        ctx.Response.Headers["Connection"] = "keep-alive";
        // nginx defaults buffer proxied responses; this header disables that for SSE.
        ctx.Response.Headers["X-Accel-Buffering"] = "no";

        // The club's own keep-alive, clamped. RealtimeSettings is where the relationship between
        // this number and nginx's unset-and-therefore-60-second proxy_read_timeout is written
        // down, and why the ceiling is 55 rather than a round minute.
        var keepAlive = KeepAliveOverride ?? RealtimeSettings.KeepAlive(await settings.GetAsync(ct));
        var topic = RealtimeTopic.Wallet(tenant.TenantId, userId);

        Channel<RealtimeMessage>? channel = null;
        try
        {
            channel = await SseStream.SubscribeThenSendAsync(
                bus, topic,
                async () => await WriteFrameAsync(
                    ctx,
                    new RealtimeMessage(
                        string.Empty,
                        JsonSerializer.Serialize(new { balance_credits = await ledger.GetBalanceAsync(userId, ct) })),
                    ct));

            await SseStream.PumpAsync(
                channel.Reader,
                keepAlive,
                (frame, token) => WriteFrameAsync(ctx, frame, token),
                token => WriteKeepAliveAsync(ctx, token),
                ct);
        }
        catch (OperationCanceledException) { /* client disconnect */ }
        finally
        {
            if (channel is not null) bus.Unsubscribe(topic, channel);
        }
    }

    /// <summary>Mints the one-minute, stream-scoped credential the SSE connection is opened with.</summary>
    /// <remarks>
    /// Named rather than inline for the same reason as <c>SignOutAsync</c>: lizard scores the
    /// whole <c>MapWalletEndpoints</c> registration as a single function, so a handler's branches
    /// are charged to the registration.
    /// </remarks>
    private static IResult MintStreamTicket(HttpContext ctx, IJwtIssuer jwt, ITenantContext tenant)
    {
        var userId = ctx.User.Id();
        if (userId is null) return Results.Unauthorized();
        var ticket = jwt.IssueOneTime(userId.Value, tenant.TenantId, tenant.TenantSlug,
            TokenPurposes.WalletStream, TokenPurposes.WalletStreamTicketTtl);
        return Results.Ok(new
        {
            ticket,
            expires_in_seconds = (int)TokenPurposes.WalletStreamTicketTtl.TotalSeconds,
        });
    }

    /// <summary>
    /// The largest adjustment the column can hold, and the smallest unit it can express.
    ///
    /// <para>
    /// <c>ledger_entries.AmountCredits</c> is <c>numeric(10,2)</c>. Neither bound was
    /// checked, and both failed badly at opposite ends. A desk typing 999999999999 got a
    /// <b>500</b> with an EF <c>DbUpdateException</c> and a Postgres 22003 numeric overflow
    /// — an unhandled database exception is the wrong failure mode for a money endpoint
    /// whatever the amount. At the other end 0.005 was accepted, stored as 0.01 because the
    /// column rounded it, and echoed back as 0.005 by the in-memory entity: half a cent
    /// created from nothing and an API response disagreeing with the ledger it had just
    /// written. Credits are counted in cents; an amount that is not a whole number of them
    /// is a typo, and rounding it silently is how the two figures diverge.
    /// </para>
    /// </summary>
    internal const decimal MaxAdjustmentCredits = 99_999_999.99m;

    internal static IResult? RefuseAmount(decimal amountCredits)
    {
        if (Math.Abs(amountCredits) > MaxAdjustmentCredits)
            return Results.BadRequest(new { error = "amount_out_of_range", max_credits = MaxAdjustmentCredits });
        if (decimal.Round(amountCredits, 2, MidpointRounding.AwayFromZero) != amountCredits)
            return Results.BadRequest(new { error = "amount_not_whole_cents" });
        return null;
    }


    /// <summary>
    /// An admin moving a member's balance by hand.
    ///
    /// <para>
    /// Idempotent when the caller names the movement. See <see cref="IdempotencyReference"/>
    /// for why the reference carries the tenant, and <c>AdminCreditAdjustHttpTests</c> for
    /// what a double-clicked Apply button used to do to the ledger.
    /// </para>
    /// </summary>
    private static async Task<IResult> AdjustAsync(
        Guid userId, AdjustRequest req, HttpContext ctx,
        [AsParameters] AdjustServices services,
        CancellationToken ct)
    {
        var (ledger, db, tenant, email, loggerFactory) = services;
        var logger = loggerFactory.CreateLogger("CreditAdjustment");

        var (refusal, kind) = RefuseRequest(req, logger);
        if (refusal is not null) return refusal;

        var reference = IdempotencyReference(tenant.TenantId, req.IdempotencyKey);
        if (reference is { Length: 0 }) return Results.BadRequest(new { error = "idempotency_key_invalid" });
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return Results.NotFound();
        if (await RefuseRelatedBooking(db, userId, req.RelatedBookingId, ct) is { } badBooking) return badBooking;

        var balanceBefore = await ledger.GetBalanceAsync(userId, ct);

        // A double-click on the desk's Apply button posted the movement twice, and a slow club
        // connection with four impatient clicks posted it four times: 44 credits granted where
        // 11 were typed. Money is ledger-only, so a duplicated row IS the wrong balance, and
        // there is nothing on the ledger to say which of the identical rows was the mistake.
        if (reference is not null && await ExistingAdjustmentAsync(db, reference, ct) is { } already)
        {
            return Replay(already, req, kind!.Value, balanceBefore, user);
        }

        LedgerEntry entry;
        try
        {
            entry = await ledger.PostAsync(new LedgerPosting(
                UserId: userId,
                Type: kind!.Value.Type,
                AmountCredits: req.AmountCredits,
                ActorUserId: ctx.User.Id() ?? Guid.Empty,
                // Naming the booking is what nets this adjustment, per leg, against a late
                // box upload's automatic reversal of the same no-show, instead of correcting
                // the member twice. See BookingService.SettledLegsAsync and the settlement
                // model's I3/I4.
                RelatedBookingId: req.RelatedBookingId,
                Reason: req.Reason,
                ExternalReference: reference), ct);
        }
        catch (DbUpdateException) when (reference is not null)
        {
            // The lookup above loses the race when both clicks are in flight at once, which is
            // exactly what a double-click produces. The unique filtered index on
            // ExternalReference is what actually holds the line; this turns its violation into
            // the same answer the first request got, so the desk sees one success rather than a
            // 500 beside a movement that did happen.
            db.ChangeTracker.Clear();
            var raced = await ExistingAdjustmentAsync(db, reference, ct);
            if (raced is null) throw;
            return Replay(raced, req, kind!.Value, balanceBefore, user);
        }

        var balanceAfter = await ledger.GetBalanceAsync(userId, ct);

        // D2-B08. The ONE by-hand money movement in the system wrote nothing to the club's audit
        // trail, while a member-class change and a password reset both write one. Reconstructing
        // "who moved what by hand" meant joining ledger_entries on Type and trusting
        // ActorUserId — which for every system posting is the empty Guid (D2-B41).
        //
        // The two balance figures are the point: an adjustment is only reviewable if the row says
        // where it took the member FROM and TO, and re-deriving that later means replaying every
        // row that has landed since.
        db.AuditLogs.Add(new Domain.AuditLog
        {
            TenantId = tenant.TenantId,
            ActorUserId = ctx.User.Id() ?? Guid.Empty,
            SubjectUserId = userId,
            Action = AdminCreditReasons.AuditAction,
            IpAddress = ctx.Connection.RemoteIpAddress?.ToString(),
            UserAgent = ctx.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua : null,
            DetailsJson = JsonSerializer.Serialize(new
            {
                user_id = userId,
                entry_id = entry.Id,
                entry_type = kind!.Value.Type.ToString(),
                amount_credits = req.AmountCredits,
                reason = req.Reason,
                reason_code = kind.Value.Code,
                balance_before_credits = balanceBefore,
                balance_after_credits = balanceAfter,
                related_booking_id = req.RelatedBookingId,
                idempotency_key = req.IdempotencyKey,
            }),
        });
        await db.SaveChangesAsync(ct);

        // "Every player-affecting event sends an email" — and an admin moving a member's balance
        // by hand is about as player-affecting as it gets. Nothing was sent, so the first a
        // member knew of a desk adjustment was the next time they opened their wallet. Background
        // dispatch: an admin is waiting on this form and SMTP is not what decides whether the
        // movement stands.
        Crusaders.Mainframe.Api.Email.EmailDispatch.InBackground(
            email, logger,
            Crusaders.Mainframe.Api.Email.EmailTemplates.CreditAdjustment(
                user.Email, entry.AmountCredits, balanceAfter, req.Reason),
            $"credit adjustment {entry.Id}");

        return AdjustmentResult(entry, kind!.Value, balanceBefore, balanceAfter, user);
    }

    /// <summary>
    /// Everything that can refuse a by-hand movement before anything is read from the database,
    /// and the kind of movement it turns out to be.
    ///
    /// <para>
    /// Its own method because <c>AdjustAsync</c> is the most consequential route in this file —
    /// it moves a member's balance by hand — and a reader asking "what will this refuse" should
    /// not have to walk the whole handler to find out.
    /// </para>
    /// </summary>
    private static (IResult? Refusal, AdminCreditReasons.Kind? Kind) RefuseRequest(
        AdjustRequest req, ILogger logger)
    {
        if (req.AmountCredits == 0) return (Results.BadRequest(new { error = "amount_zero" }), null);
        if (string.IsNullOrWhiteSpace(req.Reason)) return (Results.BadRequest(new { error = "reason_required" }), null);
        if (RefuseAmount(req.AmountCredits) is { } badAmount) return (badAmount, null);

        if (AdminCreditReasons.Resolve(req.ReasonCodeEither, logger) is not { } kind)
        {
            return (Results.BadRequest(new { error = "reason_code_invalid", valid = AdminCreditReasons.All }), null);
        }

        // A top-up is money the club TOOK. A negative one is a refund or a correction and has
        // codes of its own; mixing signs inside a directional bucket is what makes a per-row
        // listing unreadable and a revenue figure a guess.
        if (kind.Type == LedgerEntryType.AdminTopUp && req.AmountCredits < 0)
        {
            return (Results.BadRequest(new { error = "amount_must_be_positive_for_top_up" }), null);
        }

        return (null, kind);
    }

    /// <summary>
    /// What a reused idempotency key answers.
    ///
    /// <para>
    /// <b>D2-B10.</b> The replay matched on <c>ExternalReference</c> alone and compared nothing
    /// else, so adjusting +11 with key <c>k1</c> and then +110 with <c>k1</c> answered 200 with
    /// <c>amount_credits: 11</c>. A console that mints one key per FORM SESSION rather than per
    /// INTENDED MOVEMENT therefore silently discarded a corrected amount — and the admin was
    /// told it had been applied.
    /// </para>
    ///
    /// <para>
    /// A matching payload replays, exactly as before, because that is what a retried request is.
    /// A changed one is <c>409 idempotency_key_reused</c> carrying what is actually stored, for
    /// the admin to look at: silently discarding the correction is the worse of the two failures,
    /// and it is the one that leaves no trace.
    /// </para>
    /// </summary>
    private static IResult Replay(
        LedgerEntry stored, AdjustRequest req, AdminCreditReasons.Kind kind, decimal balanceBefore, Domain.User user)
    {
        var same = stored.AmountCredits == req.AmountCredits
                && stored.Type == kind.Type
                && stored.RelatedBookingId == req.RelatedBookingId;

        if (!same)
        {
            return Results.Json(new
            {
                error = "idempotency_key_reused",
                stored = new
                {
                    amount_credits = stored.AmountCredits,
                    type = stored.Type.ToString(),
                    reason = stored.Reason,
                    at = stored.CreatedAt,
                },
            }, statusCode: StatusCodes.Status409Conflict);
        }

        // The stored movement already happened, so the balance it left behind is the one before
        // it plus itself — read back rather than recomputed, so a replay quotes the same pair the
        // original did.
        return AdjustmentResult(stored, kind, balanceBefore - stored.AmountCredits, balanceBefore, user);
    }

    /// <summary>
    /// The prefix that keeps a desk adjustment's idempotency key out of the payment
    /// gateway's namespace. <c>ledger_entries.ExternalReference</c> is uniquely indexed
    /// across every row, and a top-up already stores a PayFast transaction id there.
    /// </summary>
    internal const string AdjustmentReferencePrefix = "adjust:";

    /// <summary>
    /// The <c>ExternalReference</c> a supplied idempotency key maps to: <c>null</c> when the
    /// caller sent none (the old behaviour, still allowed for anything posting by hand),
    /// and the empty string when they sent something unusable, which the caller turns into
    /// a named 400 rather than silently dropping the protection they asked for.
    ///
    /// <para>
    /// <b>The tenant id is part of the reference, and that is not decoration.</b> The unique
    /// index on <c>ExternalReference</c> is global, while every read of the table is scoped
    /// by the tenant query filter — so two clubs sending the same key would collide in the
    /// index, and the second club's lookup for its "existing" row would find nothing,
    /// because the row belongs to the first. Left un-scoped that is a 500 on a real
    /// adjustment at best, and one club's ledger row answering another club's request at
    /// worst. Scoping the reference means the keys of two clubs can never meet.
    /// </para>
    /// </summary>
    internal static string? IdempotencyReference(Guid tenantId, string? key)
    {
        if (key is null) return null;
        var trimmed = key.Trim();
        if (trimmed.Length is 0 or > 200) return "";
        return $"{AdjustmentReferencePrefix}{tenantId:N}:{trimmed}";
    }

    private static async Task<LedgerEntry?> ExistingAdjustmentAsync(
        MainframeDbContext db, string reference, CancellationToken ct)
        => await db.LedgerEntries.AsNoTracking()
            .FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);

    // Block body, not an expression body: lizard's C# parser reads the `{` of an object
    // initialiser as the end of the function and dumps the whole rest of the file into a
    // *global* pseudo-function whose reported length trips `-L 200`. See memory/gotchas.md.
    private static IResult AdjustmentResult(
        LedgerEntry entry, AdminCreditReasons.Kind kind, decimal balanceBefore, decimal balanceAfter, Domain.User user)
    {
        return Results.Ok(new
        {
            entry_id = entry.Id,
            type = entry.Type.ToString(),
            reason_code = kind.Code,
            amount_credits = entry.AmountCredits,
            // balance_before is here because the admin has to read back what they just did, and
            // because the console's confirmation ("Priya: 40.00 -> 240.00") must not be composed
            // client-side from a number it fetched separately and may have fetched before.
            balance_before_credits = balanceBefore,
            balance_after_credits = balanceAfter,
            member = new { user_id = user.Id, email = user.Email },
        });
    }

    /// <summary>
    /// Settlement model I4: an adjustment may only name a booking in this tenant whose payer
    /// is the member being adjusted.
    ///
    /// <para>
    /// The field was copied onto the ledger row with no check of any kind — any GUID, any
    /// member. A desk crediting member U while pasting member V's booking id changed <b>V's</b>
    /// settlement: V's later late-scan reversal netted a compensation that was never paid to
    /// V, and nothing on V's ledger explained it. A nonexistent id was stored silently and
    /// then surfaced in the member's recent-bookings list as a booking they never had.
    /// </para>
    ///
    /// <para>
    /// 400 rather than 404: the desk's request was well-formed and addressed a real member,
    /// and the two error codes tell them which half they got wrong. Cross-tenant is already
    /// impossible — the query filter makes another club's booking simply not exist here —
    /// so it answers <c>booking_not_found</c>, which is what it is from this tenant's side.
    /// </para>
    /// </summary>
    private static async Task<IResult?> RefuseRelatedBooking(
        MainframeDbContext db, Guid userId, Guid? relatedBookingId, CancellationToken ct)
    {
        if (relatedBookingId is not { } bookingId) return null;

        var booking = await db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null) return Results.BadRequest(new { error = "booking_not_found" });

        var payer = booking.PaidByUserId ?? booking.UserId;
        return payer == userId ? null : Results.BadRequest(new { error = "booking_not_members" });
    }

    /// <summary>
    /// One frame on the wire. An empty <see cref="RealtimeMessage.Event"/> writes the legacy
    /// unnamed frame — which <c>balance.tsx</c> listens for as <c>message</c> and which is kept
    /// verbatim through the rollout — and anything else writes a named event a client can
    /// <c>addEventListener</c> on.
    /// </summary>
    private static async Task WriteFrameAsync(HttpContext ctx, RealtimeMessage frame, CancellationToken ct)
    {
        var line = string.IsNullOrEmpty(frame.Event)
            ? $"data: {frame.JsonPayload}\n\n"
            : $"event: {frame.Event}\ndata: {frame.JsonPayload}\n\n";
        await ctx.Response.WriteAsync(line, ct);
        await ctx.Response.Body.FlushAsync(ct);
    }

    /// <summary>
    /// Forces the keep-alive interval, so the loop can be exercised at millisecond speed.
    ///
    /// <para>
    /// Null in production, where the interval comes from <c>sse_keepalive_seconds</c> through
    /// <see cref="RealtimeSettings.KeepAlive"/> — it is a configurable number, so it is a tenant
    /// setting, like every other one.
    /// </para>
    /// </summary>
    internal static TimeSpan? KeepAliveOverride { get; set; }

    /// <summary>
    /// The keep-alive, written as a NAMED event rather than an SSE comment.
    ///
    /// <para>
    /// It was <c>": ping"</c>, a comment line. Comments keep proxies from timing the
    /// connection out, which is all it was ever asked to do — but <c>EventSource</c> does
    /// not surface them, so from the browser's side a stream delivering keep-alives and a
    /// stream that has silently gone deaf look identical, and the client had no way to
    /// notice the second. As a named event it does both jobs: the bytes still defeat proxy
    /// buffering, and the client can arm a watchdog on it. Clients that do not listen for
    /// <c>ping</c> ignore it, exactly as they ignored the comment.
    /// </para>
    /// </summary>
    private static async Task WriteKeepAliveAsync(HttpContext ctx, CancellationToken ct)
    {
        await ctx.Response.WriteAsync("event: ping\ndata: {}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
    }

}

/// <summary><paramref name="RelatedBookingId"/> is optional: set it when the adjustment compensates for a specific booking.</summary>
/// <summary>
/// The services the by-hand adjustment needs, bound as one parameter.
///
/// <para>
/// A minimal-API handler's parameter list is its injection point, so listing five services
/// individually put this method over the complexity gate's six-parameter bound on a count
/// that says nothing about how hard the method is to reason about.
/// <c>[AsParameters]</c> is the framework's own answer: each member is still resolved from
/// DI exactly as before, and the signature says what the handler takes rather than what the
/// container happens to hold.
/// </para>
/// </summary>
public sealed record AdjustServices(
    LedgerService Ledger,
    MainframeDbContext Db,
    Crusaders.Mainframe.Api.Multitenancy.ITenantContext Tenant,
    Crusaders.Mainframe.Api.Email.IEmailService Email,
    ILoggerFactory LoggerFactory);

/// <summary>
/// <paramref name="RelatedBookingId"/> is optional: set it when the adjustment compensates
/// for a specific booking.
///
/// <para>
/// <paramref name="IdempotencyKey"/> is the caller's own name for THIS movement, not for the
/// member and not for the amount. The console mints one when the Apply button is first
/// pressed and keeps it until that adjustment succeeds, so every retry of one intended
/// movement carries the same key and a genuinely second adjustment of the same amount for
/// the same reason carries a different one. Omitting it is still allowed — a script posting
/// by hand has nothing to retry — but then nothing stops a repeat.
/// </para>
/// </summary>
/// <param name="ReasonCode">
/// WHAT KIND of by-hand movement this is — see <see cref="AdminCreditReasons"/>. The three
/// top-up codes post an <c>AdminTopUp</c> and count as revenue; the other four post an
/// <c>AdminAdjustment</c> and do not.
///
/// <para>
/// Nullable for one release only, read as <c>other</c> and logged as deprecated, because the
/// console gains the field in the same wave and every build already in the field would otherwise
/// start failing the moment this deploys.
/// </para>
/// </param>
public sealed record AdjustRequest(
    decimal AmountCredits,
    string Reason,
    Guid? RelatedBookingId = null,
    string? IdempotencyKey = null,
    string? ReasonCode = null,
    [property: System.Text.Json.Serialization.JsonPropertyName("reason_code")] string? ReasonCodeSnake = null)
{
    /// <summary>
    /// The code the caller sent under either spelling.
    ///
    /// <para>
    /// Both bind for the reason the settings PUT already documents at length: this API's GET
    /// answers snake_case and its bodies bind camelCase, and the cost of a client picking the
    /// wrong side is not an error — it is <c>null</c>, which here would silently downgrade a cash
    /// top-up to a goodwill adjustment and quietly drop it out of the club's revenue.
    /// </para>
    /// </summary>
    public string? ReasonCodeEither => ReasonCode ?? ReasonCodeSnake;
}
