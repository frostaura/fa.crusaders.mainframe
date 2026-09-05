using System.Text.Json;
using System.Threading.Channels;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
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
        g.MapGet("/wallet/stream", async (HttpContext ctx, LedgerService ledger, BalanceBroadcaster broadcaster, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            if (userId == Guid.Empty) { ctx.Response.StatusCode = 401; return; }

            ctx.Response.Headers["Content-Type"] = "text/event-stream";
            ctx.Response.Headers["Cache-Control"] = "no-cache, no-transform";
            ctx.Response.Headers["Connection"] = "keep-alive";
            // nginx defaults buffer proxied responses; this header disables that for SSE.
            ctx.Response.Headers["X-Accel-Buffering"] = "no";

            // Send the current balance once so the UI converges immediately on connect.
            var initial = await ledger.GetBalanceAsync(userId, ct);
            await WriteEventAsync(ctx, initial, ct);

            var channel = broadcaster.Subscribe(userId);
            try
            {
                await PumpAsync(
                    channel.Reader,
                    KeepAliveInterval,
                    (balance, token) => WriteEventAsync(ctx, balance, token),
                    token => WriteKeepAliveAsync(ctx, token),
                    ct);
            }
            catch (OperationCanceledException) { /* client disconnect */ }
            finally
            {
                broadcaster.Unsubscribe(userId, channel);
            }
        });

        // Admin: manual credit adjustment
        var admin = app.MapGroup("/api/v1/admin/credit").RequireAuthorization(p => p.RequireRole("admin"));

        // The handler is a named method rather than an inline lambda: it is the most
        // consequential route in this file - it moves a member's balance by hand - and
        // inline it pushed MapWalletEndpoints past the complexity gate, where the reported
        // number belongs to no single decision anybody could reason about.
        admin.MapPost("/{userId:guid}/adjust", AdjustAsync);

        return app;
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
            if (req.AmountCredits == 0) return Results.BadRequest(new { error = "amount_zero" });
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            if (RefuseAmount(req.AmountCredits) is { } bad2) return bad2;
            var reference = IdempotencyReference(tenant.TenantId, req.IdempotencyKey);
            if (reference is { Length: 0 }) return Results.BadRequest(new { error = "idempotency_key_invalid" });
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.NotFound();
            if (await RefuseRelatedBooking(db, userId, req.RelatedBookingId, ct) is { } bad) return bad;

            // A double-click on the desk's Apply button posted the movement twice, and a
            // slow club connection with four impatient clicks posted it four times: 44
            // credits granted where 11 were typed. Money is ledger-only, so a duplicated
            // row IS the wrong balance, and there is nothing on the ledger to say which of
            // the identical rows was the mistake.
            if (reference is not null && await ExistingAdjustmentAsync(db, reference, ct) is { } already)
                return AdjustmentResult(already, await ledger.GetBalanceAsync(userId, ct));

            LedgerEntry entry;
            try
            {
                entry = await ledger.PostAsync(new LedgerPosting(
                    UserId: userId,
                    Type: LedgerEntryType.AdminAdjustment,
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
                // The lookup above loses the race when both clicks are in flight at once,
                // which is exactly what a double-click produces. The unique filtered index
                // on ExternalReference is what actually holds the line; this turns its
                // violation into the same answer the first request got, so the desk sees
                // one success rather than a 500 beside a movement that did happen.
                db.ChangeTracker.Clear();
                var raced = await ExistingAdjustmentAsync(db, reference, ct);
                if (raced is null) throw;
                return AdjustmentResult(raced, await ledger.GetBalanceAsync(userId, ct));
            }
            var balanceAfter = await ledger.GetBalanceAsync(userId, ct);

            // "Every player-affecting event sends an email" — and an admin moving a member's
            // balance by hand is about as player-affecting as it gets. Nothing was sent, so
            // the first a member knew of a desk adjustment was the next time they opened
            // their wallet. Background dispatch: an admin is waiting on this form and SMTP
            // is not what decides whether the movement stands.
            Crusaders.Mainframe.Api.Email.EmailDispatch.InBackground(
                email, loggerFactory.CreateLogger("CreditAdjustment"),
                Crusaders.Mainframe.Api.Email.EmailTemplates.CreditAdjustment(
                    user.Email, entry.AmountCredits, balanceAfter, req.Reason),
                $"credit adjustment {entry.Id}");

            return AdjustmentResult(entry, balanceAfter);
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
    private static IResult AdjustmentResult(LedgerEntry entry, decimal balanceAfter)
    {
        return Results.Ok(new
        {
            entry_id = entry.Id,
            amount_credits = entry.AmountCredits,
            balance_after_credits = balanceAfter,
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

    private static async Task WriteEventAsync(HttpContext ctx, decimal balance, CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new { balance_credits = balance });
        await ctx.Response.WriteAsync($"data: {payload}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
    }

    /// <summary>
    /// How long the stream stays quiet before it writes a keep-alive.
    ///
    /// <para>
    /// Settable so the loop can be exercised at millisecond speed. Production never
    /// changes it: 25s sits under the 60s idle timeout nginx and every cloud load
    /// balancer in front of this API default to.
    /// </para>
    /// </summary>
    internal static TimeSpan KeepAliveInterval { get; set; } = TimeSpan.FromSeconds(25);

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

    /// <summary>
    /// Writes every published balance to one open SSE response, with a keep-alive
    /// whenever the member's balance has been still for <paramref name="keepAlive"/>.
    ///
    /// <para>
    /// This loop used to race a fresh <c>ReadAsync</c> against a fresh
    /// <c>PeriodicTimer.WaitForNextTickAsync</c> on every turn and abandon the loser, which
    /// broke the live balance twice over. An abandoned <c>ReadAsync</c> stays queued on the
    /// channel as a reader, so the next published balance was handed to a task nobody was
    /// awaiting and vanished — the member watched a stale figure until they reloaded. And
    /// <c>PeriodicTimer</c> permits exactly one outstanding waiter, so the turn after a
    /// balance <i>was</i> delivered threw <c>InvalidOperationException</c> out of the
    /// handler, after the response had started: an unhandled 500 in the log and a torn
    /// stream. Between them, a session was deaf from its first keep-alive onward.
    /// </para>
    ///
    /// <para>
    /// Nothing is abandoned here. <c>WaitToReadAsync</c> observes availability without
    /// consuming anything, so the only way an item leaves the channel is
    /// <c>TryRead</c> on the line that writes it; and the wait is ended by a linked
    /// <c>CancellationTokenSource</c>, which deregisters the waiter rather than orphaning
    /// it. The inner drain matters because the channel is bounded with
    /// <c>DropOldest</c> — several movements can land while one write is in flight.
    /// </para>
    /// </summary>
    internal static async Task PumpAsync(
        ChannelReader<decimal> reader,
        TimeSpan keepAlive,
        Func<decimal, CancellationToken, Task> writeBalance,
        Func<CancellationToken, Task> writeKeepAlive,
        CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            bool more;
            using (var quiet = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                quiet.CancelAfter(keepAlive);
                try
                {
                    more = await reader.WaitToReadAsync(quiet.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    await writeKeepAlive(ct);
                    continue;
                }
            }

            // The broadcaster completed the channel — the subscription is over.
            if (!more) return;
            while (reader.TryRead(out var balance)) await writeBalance(balance, ct);
        }
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
public sealed record AdjustRequest(
    decimal AmountCredits,
    string Reason,
    Guid? RelatedBookingId = null,
    string? IdempotencyKey = null);
