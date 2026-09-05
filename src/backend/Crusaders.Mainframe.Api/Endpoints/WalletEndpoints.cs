using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
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
                using var keepAlive = new PeriodicTimer(TimeSpan.FromSeconds(25));
                while (!ct.IsCancellationRequested)
                {
                    var readTask = channel.Reader.ReadAsync(ct).AsTask();
                    var tickTask = keepAlive.WaitForNextTickAsync(ct).AsTask();
                    var done = await Task.WhenAny(readTask, tickTask);
                    if (done == readTask)
                    {
                        var balance = await readTask;
                        await WriteEventAsync(ctx, balance, ct);
                    }
                    else
                    {
                        // SSE comment line — keeps the connection alive past proxy idle timeouts.
                        await ctx.Response.WriteAsync(": ping\n\n", ct);
                        await ctx.Response.Body.FlushAsync(ct);
                    }
                }
            }
            catch (OperationCanceledException) { /* client disconnect */ }
            finally
            {
                broadcaster.Unsubscribe(userId, channel);
            }
        });

        // Admin: manual credit adjustment
        var admin = app.MapGroup("/api/v1/admin/credit").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapPost("/{userId:guid}/adjust", async (
            Guid userId, AdjustRequest req, HttpContext ctx,
            LedgerService ledger, MainframeDbContext db,
            Crusaders.Mainframe.Api.Email.IEmailService email,
            ILoggerFactory loggerFactory,
            CancellationToken ct) =>
        {
            if (req.AmountCredits == 0) return Results.BadRequest(new { error = "amount_zero" });
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            if (RefuseAmount(req.AmountCredits) is { } bad2) return bad2;
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.NotFound();
            if (await RefuseRelatedBooking(db, userId, req.RelatedBookingId, ct) is { } bad) return bad;
            var entry = await ledger.PostAsync(new LedgerPosting(
                UserId: userId,
                Type: LedgerEntryType.AdminAdjustment,
                AmountCredits: req.AmountCredits,
                ActorUserId: ctx.User.Id() ?? Guid.Empty,
                // Naming the booking is what nets this adjustment, per leg, against a late
                // box upload's automatic reversal of the same no-show, instead of correcting
                // the member twice. See BookingService.SettledLegsAsync and the settlement
                // model's I3/I4.
                RelatedBookingId: req.RelatedBookingId,
                Reason: req.Reason), ct);
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

            return Results.Ok(new { entry_id = entry.Id, amount_credits = entry.AmountCredits, balance_after_credits = balanceAfter });
        });

        return app;
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
}

/// <summary><paramref name="RelatedBookingId"/> is optional: set it when the adjustment compensates for a specific booking.</summary>
public sealed record AdjustRequest(decimal AmountCredits, string Reason, Guid? RelatedBookingId = null);
