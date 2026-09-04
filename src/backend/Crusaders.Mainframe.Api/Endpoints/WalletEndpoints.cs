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

        g.MapGet("/wallet", async (HttpContext ctx, LedgerService ledger, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var balance = await ledger.GetBalanceAsync(userId, ct);
            var entries = await ledger.GetEntriesAsync(userId, DateTimeOffset.MinValue, DateTimeOffset.UtcNow.AddDays(1), ct);

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

        admin.MapPost("/{userId:guid}/adjust", async (Guid userId, AdjustRequest req, HttpContext ctx, LedgerService ledger, MainframeDbContext db, CancellationToken ct) =>
        {
            if (req.AmountCredits == 0) return Results.BadRequest(new { error = "amount_zero" });
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.NotFound();
            var entry = await ledger.PostAsync(new LedgerPosting(
                UserId: userId,
                Type: LedgerEntryType.AdminAdjustment,
                AmountCredits: req.AmountCredits,
                ActorUserId: ctx.User.Id() ?? Guid.Empty,
                // Naming the booking is what lets a late box upload recognise that the
                // desk already compensated the member for a wrongly-swept no-show, and
                // audit instead of correcting twice. See BookingService.ReverseNoShowAsync.
                RelatedBookingId: req.RelatedBookingId,
                Reason: req.Reason), ct);
            var balanceAfter = await ledger.GetBalanceAsync(userId, ct);
            return Results.Ok(new { entry_id = entry.Id, amount_credits = entry.AmountCredits, balance_after_credits = balanceAfter });
        });

        return app;
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
