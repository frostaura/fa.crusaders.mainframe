using System.Globalization;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class ReportingEndpoints
{
    public static IEndpointRouteBuilder MapReportingEndpoints(this IEndpointRouteBuilder app)
    {
        var me = app.MapGroup("/api/v1/reports/me").RequireAuthorization();

        me.MapGet("/wallet", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var (f, t) = ResolveRange(from, to);
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            return Results.Ok(BuildWalletReport(entries, f, t));
        });

        me.MapGet("/wallet.csv", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var (f, t) = ResolveRange(from, to);
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).OrderBy(l => l.CreatedAt).ToListAsync(ct);
            return Results.Text(LedgerCsv(entries), "text/csv", Encoding.UTF8);
        });

        var admin = app.MapGroup("/api/v1/admin/reports").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapGet("/revenue", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);
            var rows = await db.LedgerEntries.Where(l => l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var topUps = rows.Where(r => r.Type == LedgerEntryType.TopUp).Sum(r => r.AmountZar);
            var reversals = rows.Where(r => r.Type == LedgerEntryType.PaymentReversal).Sum(r => r.AmountZar);
            return Results.Ok(new { from = f, to = t, gross_topups_zar = topUps, reversals_zar = reversals, net_zar = topUps + reversals });
        });

        admin.MapGet("/utilisation", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);
            var bookings = await db.Bookings.Where(b => b.StartsAt >= f && b.StartsAt < t && b.Status != BookingStatus.Cancelled).ToListAsync(ct);
            var courts = await db.Courts.IgnoreQueryFilters().AsNoTracking()
                .ToDictionaryAsync(c => c.Id, c => new { c.CourtNumber, c.Name }, ct);
            var byCourt = bookings.GroupBy(b => b.CourtId)
                .Select(g =>
                {
                    var meta = courts.TryGetValue(g.Key, out var m) ? m : new { CourtNumber = 0, Name = "(deleted)" };
                    return new
                    {
                        court_id = g.Key,
                        court_number = meta.CourtNumber,
                        court_name = meta.Name,
                        slices = g.Sum(b => b.SliceCount),
                        bookings = g.Count(),
                        revenue_zar = g.Sum(b => b.AmountChargedZar),
                    };
                })
                .OrderBy(r => r.court_number)
                .ToList();
            return Results.Ok(new { from = f, to = t, by_court = byCourt });
        });

        admin.MapGet("/no-shows", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);
            var bookings = await db.Bookings.Where(b => b.StartsAt >= f && b.StartsAt < t).ToListAsync(ct);
            var total = bookings.Count;
            var noShow = bookings.Count(b => b.Status == BookingStatus.NoShow);
            return Results.Ok(new { from = f, to = t, total, no_show = noShow, no_show_pct = total == 0 ? 0 : Math.Round(100.0 * noShow / total, 2) });
        });

        admin.MapGet("/peripheral-health", async (MainframeDbContext db, CancellationToken ct) =>
        {
            var since = DateTimeOffset.UtcNow.AddDays(-1);
            var deliveries = await db.WebhookDeliveries.Where(d => d.CreatedAt >= since).ToListAsync(ct);
            var matches = await db.BiometricMatchEvents.Where(m => m.AttemptedAt >= since).ToListAsync(ct);
            return Results.Ok(new
            {
                webhooks_24h = new
                {
                    delivered = deliveries.Count(d => d.FinalState == "delivered"),
                    pending = deliveries.Count(d => d.FinalState == "pending"),
                    failed = deliveries.Count(d => d.FinalState == "failed" || d.FinalState == "abandoned"),
                    avg_latency_ms = deliveries.Count == 0 ? 0 : (int)deliveries.Average(d => d.LatencyMs),
                },
                biometric_24h = new
                {
                    attempts = matches.Count,
                    matches = matches.Count(m => m.Outcome == "match"),
                    no_match = matches.Count(m => m.Outcome != "match"),
                },
            });
        });

        // Daily revenue + activity buckets — shaped for line/bar charts.
        admin.MapGet("/daily", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);
            var entries = await db.LedgerEntries.Where(l => l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var bookings = await db.Bookings.Where(b => b.StartsAt >= f && b.StartsAt < t).ToListAsync(ct);

            var allDays = EnumerateDays(f, t).ToList();
            var ledgerByDay = entries.GroupBy(e => DateOnly.FromDateTime(e.CreatedAt.UtcDateTime)).ToDictionary(g => g.Key, g => g.ToList());
            var bookingsByDay = bookings.GroupBy(b => DateOnly.FromDateTime(b.StartsAt.UtcDateTime)).ToDictionary(g => g.Key, g => g.ToList());

            var rows = allDays.Select(d =>
            {
                var le = ledgerByDay.GetValueOrDefault(d) ?? new();
                var bk = bookingsByDay.GetValueOrDefault(d) ?? new();
                return new
                {
                    date = d.ToString("yyyy-MM-dd"),
                    top_ups_zar = le.Where(x => x.Type == LedgerEntryType.TopUp).Sum(x => x.AmountZar),
                    booking_charges_zar = -le.Where(x => x.Type == LedgerEntryType.BookingCharge).Sum(x => x.AmountZar),
                    refunds_zar = le.Where(x => x.Type == LedgerEntryType.CancellationRefund).Sum(x => x.AmountZar),
                    penalties_zar = -le.Where(x => x.Type == LedgerEntryType.NoShowPenalty || x.Type == LedgerEntryType.LateCancellationPenalty).Sum(x => x.AmountZar),
                    bookings = bk.Count(b => b.Status != BookingStatus.Cancelled),
                    no_shows = bk.Count(b => b.Status == BookingStatus.NoShow),
                };
            }).ToList();
            return Results.Ok(rows);
        });

        // Personal daily series (per-user wallet timeline) — drives the user's chart carousel.
        me.MapGet("/daily", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var (f, t) = ResolveRange(from, to);
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var bookings = await db.Bookings.Where(b => b.UserId == userId && b.StartsAt >= f && b.StartsAt < t).ToListAsync(ct);

            var allDays = EnumerateDays(f, t).ToList();
            var ledgerByDay = entries.GroupBy(e => DateOnly.FromDateTime(e.CreatedAt.UtcDateTime)).ToDictionary(g => g.Key, g => g.ToList());
            var bookingsByDay = bookings.GroupBy(b => DateOnly.FromDateTime(b.StartsAt.UtcDateTime)).ToDictionary(g => g.Key, g => g.ToList());

            decimal running = 0m;
            // Seed running balance with everything before the window so the chart line starts at the right value.
            running = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt < f).SumAsync(x => (decimal?)x.AmountZar, ct) ?? 0m;

            var rows = allDays.Select(d =>
            {
                var le = ledgerByDay.GetValueOrDefault(d) ?? new();
                var bk = bookingsByDay.GetValueOrDefault(d) ?? new();
                var dayDelta = le.Sum(x => x.AmountZar);
                running += dayDelta;
                return new
                {
                    date = d.ToString("yyyy-MM-dd"),
                    top_ups_zar = le.Where(x => x.Type == LedgerEntryType.TopUp).Sum(x => x.AmountZar),
                    spent_zar = -le.Where(x => x.Type == LedgerEntryType.BookingCharge).Sum(x => x.AmountZar),
                    refunds_zar = le.Where(x => x.Type == LedgerEntryType.CancellationRefund).Sum(x => x.AmountZar),
                    bookings = bk.Count(b => b.Status != BookingStatus.Cancelled),
                    balance_zar = running,
                };
            }).ToList();
            return Results.Ok(rows);
        });

        return app;
    }

    private static IEnumerable<DateOnly> EnumerateDays(DateTimeOffset from, DateTimeOffset to)
    {
        var d = DateOnly.FromDateTime(from.UtcDateTime);
        var end = DateOnly.FromDateTime(to.UtcDateTime);
        while (d <= end) { yield return d; d = d.AddDays(1); }
    }

    private static (DateTimeOffset, DateTimeOffset) ResolveRange(DateTimeOffset? from, DateTimeOffset? to)
    {
        var t = to ?? DateTimeOffset.UtcNow;
        var f = from ?? t.AddDays(-30);
        return (f, t);
    }

    private static object BuildWalletReport(List<LedgerEntry> entries, DateTimeOffset from, DateTimeOffset to)
    {
        var topUps = entries.Where(e => e.Type == LedgerEntryType.TopUp).Sum(e => e.AmountZar);
        var spent = -entries.Where(e => e.Type == LedgerEntryType.BookingCharge).Sum(e => e.AmountZar);
        var refunds = entries.Where(e => e.Type == LedgerEntryType.CancellationRefund).Sum(e => e.AmountZar);
        var penalties = entries.Where(e => e.Type == LedgerEntryType.NoShowPenalty || e.Type == LedgerEntryType.LateCancellationPenalty).Count();
        return new { from, to, top_ups_zar = topUps, spent_zar = spent, refunds_zar = refunds, penalty_count = penalties, count = entries.Count };
    }

    private static string LedgerCsv(IEnumerable<LedgerEntry> entries)
    {
        var sb = new StringBuilder();
        sb.AppendLine("created_at,type,amount_zar,reason,external_reference,related_booking_id");
        foreach (var e in entries)
        {
            sb.Append(e.CreatedAt.ToString("o", CultureInfo.InvariantCulture)).Append(',');
            sb.Append(e.Type).Append(',');
            sb.Append(e.AmountZar.ToString(CultureInfo.InvariantCulture)).Append(',');
            sb.Append(Csv(e.Reason)).Append(',');
            sb.Append(Csv(e.ExternalReference)).Append(',');
            sb.AppendLine(e.RelatedBookingId?.ToString() ?? "");
        }
        return sb.ToString();
    }

    private static string Csv(string? v)
    {
        if (string.IsNullOrEmpty(v)) return "";
        var needs = v.Contains(',') || v.Contains('"') || v.Contains('\n');
        return needs ? "\"" + v.Replace("\"", "\"\"") + "\"" : v;
    }
}
