using System.Globalization;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
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
            var attended = await db.Bookings
                .Where(b => b.UserId == userId && b.StartsAt >= f && b.StartsAt < t && b.CheckedInAt != null)
                .Select(b => new { b.SliceMinutes, b.SliceCount })
                .ToListAsync(ct);
            return Results.Ok(BuildWalletReport(
                entries, f, t,
                attendedBookings: attended.Count,
                minutesOnCourt: attended.Sum(b => b.SliceMinutes * b.SliceCount)));
        });

        me.MapGet("/wallet.csv", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var (f, t) = ResolveRange(from, to);
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).OrderBy(l => l.CreatedAt).ToListAsync(ct);

            // Named, per reporting.md's filename pattern. The browser cannot follow this URL
            // on its own — the endpoint needs an Authorization header, which is why the
            // "Download wallet CSV" link silently downloaded nothing — so the client fetches
            // it and saves the body; the header is what tells it what to call the file.
            var name = $"crusaders-mainframe_wallet_{f:yyyy-MM-dd}-{t:yyyy-MM-dd}.csv";
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
            return Results.Text(LedgerCsv(entries), "text/csv", Encoding.UTF8);
        });

        var admin = app.MapGroup("/api/v1/admin/reports").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapGet("/revenue", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);
            var rows = await db.LedgerEntries.Where(l => l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var funding = rows.Where(r => LedgerEntryTypes.Funding.Contains(r.Type)).ToList();
            var reversed = rows.Where(r => LedgerEntryTypes.Reversal.Contains(r.Type)).ToList();

            // Rand comes from ZarPaid; credits come from AmountCredits. They are not
            // interchangeable and this endpoint used to treat them as though they were —
            // it summed AmountCredits and labelled the result gross_topups_zar, which the
            // admin revenue page then printed with a rand sign. A Regular member's R1000
            // top-up posts 1600 credits and a League member's posts 2400, so the club was
            // shown R1600–R2400 of income for R1000 actually received, and no amount of
            // arithmetic downstream could unmix the two classes once summed.
            //
            // Both figures are now reported side by side, each under a name that says what
            // unit it is in — which is the same rule AdminMemberEndpoints already followed.
            return Results.Ok(new
            {
                from = f,
                to = t,
                gross_topups_zar = funding.Sum(SignedZar),
                reversals_zar = reversed.Sum(SignedZar),
                net_zar = funding.Sum(SignedZar) + reversed.Sum(SignedZar),
                gross_topups_credits = funding.Sum(r => r.AmountCredits),
                reversals_credits = reversed.Sum(r => r.AmountCredits),
                net_credits = funding.Sum(r => r.AmountCredits) + reversed.Sum(r => r.AmountCredits),
            });
        });

        admin.MapGet("/utilisation", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);
            var bookings = await db.Bookings.Where(b => b.StartsAt >= f && b.StartsAt < t && b.Status != BookingStatus.Cancelled).ToListAsync(ct);
            var courts = await db.Courts.IgnoreQueryFilters().AsNoTracking()
                .ToDictionaryAsync(c => c.Id, c => new { c.CourtNumber, c.Name }, ct);

            // Revenue is what the club KEPT, read off the ledger — not the price quoted at
            // booking. This summed AmountChargedCredits, so a booking that was swept as a
            // no-show (charged −50, refunded +50, penalised −15, then credited +5 by the
            // desk) counted as 50 of revenue when settlement-model S5 says the club's take
            // is the penalty, netted per I3, and the ledger says 10. Court 4 read 100 on a
            // real take of 60. Summing the rows that name each booking is the definition of
            // Owed in §2, so the report and the normative model cannot disagree again.
            var bookingIds = bookings.Select(b => b.Id).ToList();
            var settled = await db.LedgerEntries
                .Where(l => l.RelatedBookingId != null && bookingIds.Contains(l.RelatedBookingId!.Value))
                .GroupBy(l => l.RelatedBookingId!.Value)
                .Select(g => new { BookingId = g.Key, Credits = g.Sum(x => x.AmountCredits) })
                .ToDictionaryAsync(x => x.BookingId, x => x.Credits, ct);

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
                        // Slices mixed units: a 60-minute walk-up is SliceCount 1 and counted
                        // the same as a 15-minute booking. Minutes are the comparable figure
                        // and are what a utilisation percentage would have to be built from.
                        booked_minutes = g.Sum(b => b.SliceMinutes * b.SliceCount),
                        bookings = g.Count(),
                        revenue_credits = g.Sum(b => -settled.GetValueOrDefault(b.Id, 0m)),
                        quoted_credits = g.Sum(b => b.AmountChargedCredits),
                    };
                })
                .OrderBy(r => r.court_number)
                .ToList();
            return Results.Ok(new { from = f, to = t, by_court = byCourt });
        });

        admin.MapGet("/no-shows", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);

            // The denominator is bookings that could have been shown up for: not
            // cancellations (a cancellation is not a no-show, per reporting.md's "% of
            // bookings that no-showed"), and not slots that have not started yet. It counted
            // every booking in the window, so this KPI divided by 10 while the daily table
            // beside it divided by 8 — one dashboard showing 40% and 50% for the same day.
            var now = DateTimeOffset.UtcNow;
            var bookings = await db.Bookings
                .Where(b => b.StartsAt >= f && b.StartsAt < t
                         && b.Status != BookingStatus.Cancelled
                         && b.StartsAt <= now)
                .ToListAsync(ct);
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
        //
        // Two things about a row here, both of which it used to get wrong.
        //
        // FIRST, the day is the CLUB'S day. Both groupings bucketed on
        // `DateOnly.FromDateTime(x.UtcDateTime)` while the club runs Africa/Johannesburg, so
        // every movement between 00:00 and 02:00 local landed in the previous day's row —
        // and on the 1st of a month, in the previous month's report. `reporting.md` has said
        // "all reports honor the tenant's tenant_settings.timezone" since it was written.
        //
        // SECOND, a row deliberately carries TWO date bases and now says so. The money
        // columns count the day the money moved (`CreatedAt`); `bookings` and `no_shows`
        // count the day the court is played (`StartsAt`). They are different questions and
        // the club wants both, but read as one row they contradict each other — "Charges
        // 2300.00 cr, Bookings 6" at 50.00 cr a slice is 46 bookings, not 6 — because
        // `advance_booking_days` is 14, so a fortnight of charges lands on days whose courts
        // are played later, or beyond the window entirely. The screen names both clocks under the
        // table now; nothing on the page said it before, and a reader had no way to know
        // two were in play. The wire shape stays a flat array of days on purpose — it is
        // what the charts, the client type and the browser fixtures all read.
        admin.MapGet("/daily", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var (f, t) = ResolveRange(from, to);
            var tz = ResolveTz((await settingsAccessor.GetAsync(ct)).Timezone);
            var entries = await db.LedgerEntries.Where(l => l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var bookings = await db.Bookings.Where(b => b.StartsAt >= f && b.StartsAt < t).ToListAsync(ct);

            var allDays = EnumerateDays(f, t, tz).ToList();
            var ledgerByDay = entries.GroupBy(e => LocalDay(e.CreatedAt, tz)).ToDictionary(g => g.Key, g => g.ToList());
            var bookingsByDay = bookings.GroupBy(b => LocalDay(b.StartsAt, tz)).ToDictionary(g => g.Key, g => g.ToList());

            var rows = allDays.Select(d =>
            {
                var le = ledgerByDay.GetValueOrDefault(d) ?? new();
                var bk = bookingsByDay.GetValueOrDefault(d) ?? new();
                return new
                {
                    date = d.ToString("yyyy-MM-dd"),
                    top_ups_credits = le.Where(x => LedgerEntryTypes.Funding.Contains(x.Type)).Sum(x => x.AmountCredits),
                    booking_charges_credits = -le.Where(x => LedgerEntryTypes.Spend.Contains(x.Type)).Sum(x => x.AmountCredits),
                    refunds_credits = le.Where(x => LedgerEntryTypes.Refund.Contains(x.Type)).Sum(x => x.AmountCredits),
                    penalties_credits = -le.Where(x => LedgerEntryTypes.Penalty.Contains(x.Type)).Sum(x => x.AmountCredits),
                    // What the desk handed out or took back by hand. It was in the member's
                    // own report and on Transactions and nowhere on the club's report — a
                    // tenant with 2,525.50 credits of AdminAdjustment had no screen that
                    // showed the figure at all, on the report whose job is where the money
                    // went.
                    adjustments_credits = le.Where(x => LedgerEntryTypes.Adjustment.Contains(x.Type)).Sum(x => x.AmountCredits),
                    bookings = bk.Count(b => b.Status != BookingStatus.Cancelled),
                    no_shows = bk.Count(b => b.Status == BookingStatus.NoShow),
                };
            }).ToList();
            return Results.Ok(rows);
        });

        // Personal daily series (per-user wallet timeline) — drives the user's chart carousel.
        me.MapGet("/daily", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var (f, t) = ResolveRange(from, to);
            // The club's day here too: a member topping up at 00:30 on the 1st saw it land
            // in the previous month's report.
            var tz = ResolveTz((await settingsAccessor.GetAsync(ct)).Timezone);
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var bookings = await db.Bookings.Where(b => b.UserId == userId && b.StartsAt >= f && b.StartsAt < t).ToListAsync(ct);

            var allDays = EnumerateDays(f, t, tz).ToList();
            var ledgerByDay = entries.GroupBy(e => LocalDay(e.CreatedAt, tz)).ToDictionary(g => g.Key, g => g.ToList());
            var bookingsByDay = bookings.GroupBy(b => LocalDay(b.StartsAt, tz)).ToDictionary(g => g.Key, g => g.ToList());

            decimal running = 0m;
            // Seed running balance with everything before the window so the chart line starts at the right value.
            running = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt < f).SumAsync(x => (decimal?)x.AmountCredits, ct) ?? 0m;

            var rows = allDays.Select(d =>
            {
                var le = ledgerByDay.GetValueOrDefault(d) ?? new();
                var bk = bookingsByDay.GetValueOrDefault(d) ?? new();
                var dayDelta = le.Sum(x => x.AmountCredits);
                running += dayDelta;
                return new
                {
                    date = d.ToString("yyyy-MM-dd"),
                    top_ups_credits = le.Where(x => LedgerEntryTypes.Funding.Contains(x.Type)).Sum(x => x.AmountCredits),
                    spent_credits = -le.Where(x => LedgerEntryTypes.Spend.Contains(x.Type)).Sum(x => x.AmountCredits),
                    refunds_credits = le.Where(x => LedgerEntryTypes.Refund.Contains(x.Type)).Sum(x => x.AmountCredits),
                    bookings = bk.Count(b => b.Status != BookingStatus.Cancelled),
                    // Attendance, which nothing in the product showed anywhere. CheckedInAt
                    // is the source of truth for it — the settlement model hangs the refund
                    // and the no-show penalty off this field — and a member could not see
                    // whether the club believed they had turned up.
                    attended = bk.Count(b => b.CheckedInAt is not null),
                    minutes_on_court = bk.Where(b => b.CheckedInAt is not null).Sum(b => b.SliceMinutes * b.SliceCount),
                    balance_credits = running,
                };
            }).ToList();
            return Results.Ok(rows);
        });

        return app;
    }

    /// <summary>
    /// The rand a ledger row moved, signed the way its credits are.
    ///
    /// <para>
    /// <c>ZarPaid</c> records what the member actually paid and is populated on funding and
    /// reversal rows. Its stored sign cannot be relied on — <c>PaymentReversal</c> has no
    /// producer yet, so no convention has been set by real data — while the credit amount's
    /// sign is load-bearing everywhere else in this file. Taking the direction from the
    /// credits keeps a reversal subtracting from revenue whichever way the rand figure is
    /// eventually written.
    /// </para>
    /// </summary>
    private static decimal SignedZar(LedgerEntry e)
    {
        var rand = Math.Abs(e.ZarPaid ?? 0m);
        return e.AmountCredits < 0 ? -rand : rand;
    }

    /// <summary>The club-local calendar day an instant falls on, per <c>reporting.md</c>.</summary>
    private static DateOnly LocalDay(DateTimeOffset at, TimeZoneInfo tz)
    {
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, tz).DateTime);
    }

    /// <summary>
    /// The tenant's zone, falling back to UTC on an id this machine does not carry.
    ///
    /// <para>
    /// Same shape as <c>BookingService.ResolveTz</c> and for the same reason: a settings
    /// document naming a zone the host has no tzdb entry for must not make every report
    /// throw. A report an hour out is recoverable; a 500 on /reports is not.
    /// </para>
    /// </summary>
    private static TimeZoneInfo ResolveTz(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }

    private static IEnumerable<DateOnly> EnumerateDays(DateTimeOffset from, DateTimeOffset to, TimeZoneInfo tz)
    {
        var d = LocalDay(from, tz);
        var end = LocalDay(to, tz);
        while (d <= end) { yield return d; d = d.AddDays(1); }
    }

    private static (DateTimeOffset, DateTimeOffset) ResolveRange(DateTimeOffset? from, DateTimeOffset? to)
    {
        var t = to ?? DateTimeOffset.UtcNow;
        var f = from ?? t.AddDays(-30);
        return (f, t);
    }

    /// <summary>
    /// The member's own period summary.
    ///
    /// <para>
    /// <b>It must reconcile.</b> It reported top-ups, spend, refunds and a penalty count and
    /// nothing else, so a member whose ledger held 2,500 credits of admin adjustments read
    /// "0 in, 950 out, 100 back" on a page whose header said 1,635 — the two screens
    /// disagreeing with no way to see why. Every bucket a movement can land in is now here,
    /// and <c>net_movement_credits</c> is their sum: for a range covering the whole ledger
    /// it equals the balance, and for any other range it is exactly what the balance moved
    /// by. <c>penalties_credits</c> is the total <c>reporting.md</c> asks for beside the
    /// count it already had.
    /// </para>
    /// </summary>
    internal static object BuildWalletReport(
        List<LedgerEntry> entries, DateTimeOffset from, DateTimeOffset to,
        int attendedBookings = 0, int minutesOnCourt = 0)
    {
        var topUps = entries.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.AmountCredits);
        var spent = -entries.Where(e => LedgerEntryTypes.Spend.Contains(e.Type)).Sum(e => e.AmountCredits);
        var refunds = entries.Where(e => LedgerEntryTypes.Refund.Contains(e.Type)).Sum(e => e.AmountCredits);
        var penaltiesTotal = -entries.Where(e => LedgerEntryTypes.Penalty.Contains(e.Type)).Sum(e => e.AmountCredits);
        var adjustments = entries.Where(e => LedgerEntryTypes.Adjustment.Contains(e.Type)).Sum(e => e.AmountCredits);
        var reversals = entries.Where(e => LedgerEntryTypes.Reversal.Contains(e.Type)).Sum(e => e.AmountCredits);
        // A penalty is a debit. A reversed no-show posts a positive row of the same type
        // to give the money back, and that row is not a second penalty.
        var penalties = entries.Count(e => LedgerEntryTypes.Penalty.Contains(e.Type) && e.AmountCredits < 0);
        return new
        {
            from,
            to,
            top_ups_credits = topUps,
            spent_credits = spent,
            refunds_credits = refunds,
            penalties_credits = penaltiesTotal,
            adjustments_credits = adjustments,
            reversals_credits = reversals,
            net_movement_credits = entries.Sum(e => e.AmountCredits),
            penalty_count = penalties,
            attended_bookings = attendedBookings,
            minutes_on_court = minutesOnCourt,
            count = entries.Count,
        };
    }

    private static string LedgerCsv(IEnumerable<LedgerEntry> entries)
    {
        var sb = new StringBuilder();
        sb.AppendLine("created_at,type,amount_credits,reason,external_reference,related_booking_id");
        foreach (var e in entries)
        {
            sb.Append(e.CreatedAt.ToString("o", CultureInfo.InvariantCulture)).Append(',');
            sb.Append(e.Type).Append(',');
            sb.Append(e.AmountCredits.ToString(CultureInfo.InvariantCulture)).Append(',');
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
