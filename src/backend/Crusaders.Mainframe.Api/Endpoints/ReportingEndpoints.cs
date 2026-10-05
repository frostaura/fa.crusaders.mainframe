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

        me.MapGet("/wallet", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var (_, _, f, t) = ResolveWindow(from, to, await ClubZoneAsync(settingsAccessor, ct));
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var attended = await SessionsInAsync(db, userId, f, t, ct);
            return Results.Ok(BuildWalletReport(
                entries, f, t,
                attendedBookings: attended.Count,
                minutesOnCourt: attended.Sum(s => s.PlayedMinutes)));
        });

        me.MapGet("/wallet.csv", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var (firstDay, lastDay, f, t) = ResolveWindow(from, to, await ClubZoneAsync(settingsAccessor, ct));
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).OrderBy(l => l.CreatedAt).ToListAsync(ct);

            // Named, per reporting.md's filename pattern. The browser cannot follow this URL
            // on its own — the endpoint needs an Authorization header, which is why the
            // "Download wallet CSV" link silently downloaded nothing — so the client fetches
            // it and saves the body; the header is what tells it what to call the file.
            // The club's own first and last day, not the UTC window's edges: the window
            // ends at the START of the day after the last one, so formatting `t` would name
            // a day the file does not contain.
            var name = $"crusaders-mainframe_wallet_{firstDay:yyyy-MM-dd}-{lastDay:yyyy-MM-dd}.csv";
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
            return Results.Text(LedgerCsv(entries), "text/csv", Encoding.UTF8);
        });

        var admin = app.MapGroup("/api/v1/admin/reports").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapGet("/revenue", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var (_, _, f, t) = ResolveWindow(from, to, await ClubZoneAsync(settingsAccessor, ct));
            var rows = await db.LedgerEntries.Where(l => l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            // R13 J13-2: minutes the club GAVE (a desk package_free, or one recorded at R0.00) were
            // never sold. Counted in, one free package beside one paid one halved the rand per
            // hour sold. They are their own figure; sold + given is every funding row's minutes.
            var funding = rows.Where(r => LedgerEntryTypes.Funding.Contains(r.Type) && !IsGiven(r)).ToList();
            var reversed = rows.Where(r => LedgerEntryTypes.Reversal.Contains(r.Type)).ToList();

            // Rand comes from ZarPaid; minutes come from AmountMinutes. They are not
            // interchangeable and this endpoint once treated them as though they were — it
            // summed the ledger unit and labelled the result gross_topups_zar, which the admin
            // revenue page then printed with a rand sign, and no amount of arithmetic
            // downstream could unmix the two once summed. Both are reported side by side, each
            // under a name that says what unit it is in, and the one honest bridge between them
            // is a RATE over the window (contract §3.15) — never a conversion of either.
            var netZar = funding.Sum(SignedZar) + reversed.Sum(SignedZar);
            var netMinutes = funding.Sum(r => r.AmountMinutes) + reversed.Sum(r => r.AmountMinutes);
            return Results.Ok(new
            {
                from = f,
                to = t,
                gross_topups_zar = funding.Sum(SignedZar),
                reversals_zar = reversed.Sum(SignedZar),
                net_zar = netZar,
                gross_topups_minutes = funding.Sum(r => r.AmountMinutes),
                reversals_minutes = reversed.Sum(r => r.AmountMinutes),
                net_minutes = netMinutes,
                given_minutes = GivenMinutes(rows),
                zar_per_minute_sold = ZarPerMinuteSold(netZar, netMinutes),
            });
        });

        admin.MapGet("/utilisation", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var (_, _, f, t) = ResolveWindow(from, to, await ClubZoneAsync(settingsAccessor, ct));
            // D2-B35 — a block is not a booking, and with item 14's schedules that stopped
            // being a nuisance and became a permanently wrong figure.
            //
            // All three club reports counted `Status != Cancelled`, which includes AdminBlock:
            // a row with UserId null, costing 0, with no ledger entry behind it. Blocking four
            // courts for four hours reported 960 minutes of "use" nobody bought. A league
            // season adds hundreds of those rows every term.
            //
            // Held time is still something a club wants to see — a court held for league IS
            // unavailable — so it becomes its OWN number rather than being folded into paid
            // use or dropped.
            var all = await db.Bookings.Where(b => b.StartsAt >= f && b.StartsAt < t && b.Status != BookingStatus.Cancelled).ToListAsync(ct);
            var bookings = all.Where(b => b.Status != BookingStatus.AdminBlock).ToList();
            var blockedByCourt = all.Where(b => b.Status == BookingStatus.AdminBlock)
                .GroupBy(b => b.CourtId)
                .ToDictionary(g => g.Key, g => g.Sum(b => b.SliceMinutes * b.SliceCount));
            var courts = await db.Courts.IgnoreQueryFilters().AsNoTracking()
                .ToDictionaryAsync(c => c.Id, c => new { c.CourtNumber, c.Name }, ct);

            // Revenue is what the club KEPT, read off the ledger — not the price quoted at
            // booking. This summed AmountChargedMinutes, so a booking that was swept as a
            // no-show (charged −50, refunded +50, penalised −15, then given +5 by the
            // desk) counted as 50 of revenue when settlement-model S5 says the club's take
            // is the penalty, netted per I3, and the ledger says 10. Court 4 read 100 on a
            // real take of 60. Summing the rows that name each booking is the definition of
            // Owed in §2, so the report and the normative model cannot disagree again.
            var bookingIds = bookings.Select(b => b.Id).ToList();
            var settled = await db.LedgerEntries
                .Where(l => l.RelatedBookingId != null && bookingIds.Contains(l.RelatedBookingId!.Value))
                .GroupBy(l => l.RelatedBookingId!.Value)
                .Select(g => new { BookingId = g.Key, Minutes = g.Sum(x => x.AmountMinutes) })
                .ToDictionaryAsync(x => x.BookingId, x => x.Minutes, ct);

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
                        kept_minutes = g.Sum(b => -settled.GetValueOrDefault(b.Id, 0)),
                        sold_minutes = g.Sum(b => b.AmountChargedMinutes),
                        blocked_minutes = blockedByCourt.GetValueOrDefault(g.Key, 0),
                    };
                })
                .OrderBy(r => r.court_number)
                .ToList();
            return Results.Ok(new { from = f, to = t, by_court = byCourt });
        });

        admin.MapGet("/no-shows", async (DateTimeOffset? from, DateTimeOffset? to, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var (_, _, f, t) = ResolveWindow(from, to, await ClubZoneAsync(settingsAccessor, ct));

            // The denominator is bookings that could have been shown up for: not
            // cancellations (a cancellation is not a no-show, per reporting.md's "% of
            // bookings that no-showed"), and not slots that have not started yet. It counted
            // every booking in the window, so this KPI divided by 10 while the daily table
            // beside it divided by 8 — one dashboard showing 40% and 50% for the same day.
            var now = DateTimeOffset.UtcNow;
            var bookings = await db.Bookings
                .Where(b => b.StartsAt >= f && b.StartsAt < t
                         && b.Status != BookingStatus.Cancelled
                         // D2-B35 — an admin block cannot be a no-show, so counting it in the
                         // denominator dilutes the percentage. With league nights in the
                         // denominator the figure halves, permanently.
                         && b.Status != BookingStatus.AdminBlock
                         && b.StartsAt <= now)
                .ToListAsync(ct);
            var total = bookings.Count;
            // E6-6: a booking refunded in full because its box was dark is not a no-show.
            var noShow = bookings.Count(NoShows.IsCounted);
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
        // FIRST, the day is the CLUB'S day — the buckets AND the window. Both groupings
        // bucketed on `DateOnly.FromDateTime(x.UtcDateTime)` while the club runs
        // Africa/Johannesburg, so every movement between 00:00 and 02:00 local landed in the
        // previous day's row — and on the 1st of a month, in the previous month's report.
        // Cutting the buckets in the tenant's zone while leaving the WINDOW in UTC then
        // dropped that same band off the front of the report and imported a day off the back
        // of it; `ResolveWindow` is where both ends are settled, and why. `reporting.md` has
        // said "all reports honor the tenant's tenant_settings.timezone" since it was written.
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
            var tz = await ClubZoneAsync(settingsAccessor, ct);
            var (firstDay, lastDay, f, t) = ResolveWindow(from, to, tz);
            var entries = await db.LedgerEntries.Where(l => l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var bookings = await db.Bookings.Where(b => b.StartsAt >= f && b.StartsAt < t).ToListAsync(ct);

            var allDays = EnumerateDays(firstDay, lastDay).ToList();
            var ledgerByDay = entries.GroupBy(e => LocalDay(e.CreatedAt, tz)).ToDictionary(g => g.Key, g => g.ToList());
            var bookingsByDay = bookings.GroupBy(b => LocalDay(b.StartsAt, tz)).ToDictionary(g => g.Key, g => g.ToList());

            var rows = allDays.Select(d =>
            {
                var le = ledgerByDay.GetValueOrDefault(d) ?? new();
                var bk = bookingsByDay.GetValueOrDefault(d) ?? new();
                return new
                {
                    date = d.ToString("yyyy-MM-dd"),
                    top_ups_minutes = le.Where(x => LedgerEntryTypes.Funding.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    // R14 J14-2: the part of top_ups_minutes the club GAVE (a desk package_free, or a
                    // sale at R0.00) — a SUBSET, so the buckets still sum to net_movement_minutes. The
                    // page's "Sold" is top-ups less this, as the revenue totals' sold already is.
                    given_minutes = GivenMinutes(le),
                    booking_charges_minutes = -le.Where(x => LedgerEntryTypes.Spend.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    refunds_minutes = le.Where(x => LedgerEntryTypes.Refund.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    penalties_minutes = -le.Where(x => LedgerEntryTypes.Penalty.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    // What the desk handed out or took back by hand. It was in the member's
                    // own report and on Transactions and nowhere on the club's report — a
                    // tenant with 2,525 minutes of AdminAdjustment had no screen that
                    // showed the figure at all, on the report whose job is where the money
                    // went.
                    adjustments_minutes = le.Where(x => LedgerEntryTypes.Adjustment.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    // A payment clawed back after the fact. It was in NO bucket: this row
                    // summed Funding, Spend, Refund, Penalty and Adjustment and stopped,
                    // under a card that called those five "every ledger movement in the club
                    // summed". A -160.00 reversal inside the window made the card print
                    // +555.00 over a true movement of +395.00. The member's own report has
                    // carried `reversals_minutes` since it was made to reconcile; the club's
                    // had not, so the two screens disagreed by exactly the reversals.
                    reversals_minutes = le.Where(x => LedgerEntryTypes.Reversal.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    // D11: shares moving between two members. Club-wide the pairs net to zero,
                    // so this reads 0 on every real day; it is here so the buckets still sum to
                    // net_movement_minutes whatever the ledger holds.
                    share_transfers_minutes = le.Where(x => LedgerEntryTypes.Transfer.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    // The day's movement, summed WITHOUT looking at the type — the same
                    // arithmetic `net_movement_minutes` uses on the member's own report, so
                    // the two screens cannot mean different things by "net".
                    //
                    // It is also the guard. The six bucket columns above must add up to this
                    // one, and `DailyReportTests` posts a row of EVERY member of
                    // `LedgerEntryType` and asserts they do — so a type added to the enum and
                    // left out of the buckets here goes red with the arithmetic in the
                    // message, instead of quietly making the club's report stop summing to
                    // its own total. `LedgerEntryTypeCoverageTests` asserts the bucket TABLE
                    // is total; it cannot see whether an endpoint uses all of it.
                    net_movement_minutes = le.Sum(x => x.AmountMinutes),
                    // D2-B35. The member-facing /reports/me/daily further down is NOT
                    // changed by this: it is pre-filtered by UserId, and a block has none.
                    bookings = bk.Count(b => b.Status is not BookingStatus.Cancelled and not BookingStatus.AdminBlock),
                    blocked = bk.Count(b => b.Status == BookingStatus.AdminBlock),
                    no_shows = bk.Count(NoShows.IsCounted),
                };
            }).ToList();
            return Results.Ok(rows);
        });

        // Personal daily series (per-user wallet timeline) — drives the user's chart carousel.
        me.MapGet("/daily", async (DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            // The club's day here too, at both ends: a member topping up at 00:30 on the 1st
            // saw it land in the previous month's report, and then — once the buckets moved
            // to the club's clock but the window did not — vanish from the report entirely.
            var tz = await ClubZoneAsync(settingsAccessor, ct);
            var (firstDay, lastDay, f, t) = ResolveWindow(from, to, tz);
            var entries = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt >= f && l.CreatedAt < t).ToListAsync(ct);
            var bookings = await db.Bookings.Where(b => b.UserId == userId && b.StartsAt >= f && b.StartsAt < t).ToListAsync(ct);

            var allDays = EnumerateDays(firstDay, lastDay).ToList();
            var ledgerByDay = entries.GroupBy(e => LocalDay(e.CreatedAt, tz)).ToDictionary(g => g.Key, g => g.ToList());
            var bookingsByDay = bookings.GroupBy(b => LocalDay(b.StartsAt, tz)).ToDictionary(g => g.Key, g => g.ToList());
            var sessionsByDay = (await SessionsInAsync(db, userId, f, t, ct))
                .GroupBy(s => LocalDay(s.StartsAt, tz)).ToDictionary(g => g.Key, g => g.ToList());

            int running = 0;
            // Seed running balance with everything before the window so the chart line starts at the right value.
            running = await db.LedgerEntries.Where(l => l.UserId == userId && l.CreatedAt < f).SumAsync(x => (int?)x.AmountMinutes, ct) ?? 0;

            var rows = allDays.Select(d =>
            {
                var le = ledgerByDay.GetValueOrDefault(d) ?? new();
                var bk = bookingsByDay.GetValueOrDefault(d) ?? new();
                var played = sessionsByDay.GetValueOrDefault(d) ?? new();
                var dayDelta = le.Sum(x => x.AmountMinutes);
                running += dayDelta;
                return new
                {
                    date = d.ToString("yyyy-MM-dd"),
                    top_ups_minutes = le.Where(x => LedgerEntryTypes.Funding.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    // R11 J11-4: the part of top_ups_minutes the club gave at no charge (a subset; not summed twice).
                    given_minutes = GivenMinutes(le),
                    spent_minutes = -le.Where(x => LedgerEntryTypes.Spend.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    refunds_minutes = le.Where(x => LedgerEntryTypes.Refund.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    // Review round 7, J7-2: every bucket the wallet report has, so a day's row adds
                    // up to what the balance moved that day. Without these four a day with a share,
                    // a penalty or a desk adjustment read "+4 h 48 min" beside columns summing to
                    // something else. Same signs as /reports/me/wallet: penalties as a positive
                    // figure taken, the others signed as they moved.
                    penalties_minutes = -le.Where(x => LedgerEntryTypes.Penalty.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    adjustments_minutes = le.Where(x => LedgerEntryTypes.Adjustment.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    reversals_minutes = le.Where(x => LedgerEntryTypes.Reversal.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    share_transfers_minutes = le.Where(x => LedgerEntryTypes.Transfer.Contains(x.Type)).Sum(x => x.AmountMinutes),
                    net_movement_minutes = dayDelta,
                    bookings = bk.Count(b => b.Status != BookingStatus.Cancelled),
                    // Attendance, which nothing in the product showed anywhere. CheckedInAt
                    // is the source of truth for it — the settlement model hangs the refund
                    // and the no-show penalty off this field — and a member could not see
                    // whether the club believed they had turned up.
                    // Time on court by the play rule (E8-4): sessions as booker or accepted partner,
                    // played minutes as the row stands — the figure the profile shows.
                    attended = played.Count,
                    minutes_on_court = played.Sum(s => s.PlayedMinutes),
                    balance_minutes = running,
                };
            }).ToList();
            return Results.Ok(rows);
        });

        return app;
    }

    /// <summary>
    /// The member's attended sessions whose court time starts inside the window — "time on court"
    /// by ONE rule on every member screen (review round 8, E8-4): <see cref="AttendanceQuery"/>,
    /// play.md §1. A booking they made OR an accepted seat in somebody else's game, attended by
    /// <c>CheckedInAt</c>, and its minutes as the row stands (a released tail and a cancellation
    /// after check-in stop the clock). The wallet report had counted only bookings the member
    /// made, at their sold length, so a partner read "0 min" on Wallet beside "57 min" on Profile.
    /// </summary>
    private static async Task<List<AttendedSession>> SessionsInAsync(
        MainframeDbContext db, Guid userId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        var sessions = await AttendanceQuery.SessionsAsync(db, userId, ct);
        return sessions.Where(s => s.StartsAt >= from && s.StartsAt < to).ToList();
    }

    /// <summary>
    /// What the club took per minute it sold over a window: <c>net_zar ÷ net_minutes</c>, rounded
    /// DOWN to 4 decimals, and null when no minutes were sold net (contract §3.15). Down, so the
    /// report never claims a rate the club did not earn; null rather than 0 or a division error,
    /// because "no rate" is a different fact from "a rate of nothing". A discount, a package of
    /// another size or a desk sale for less than the shelf price all move it, which is the point.
    /// </summary>
    public static decimal? ZarPerMinuteSold(decimal netZar, int netMinutes)
    {
        if (netMinutes <= 0) return null;
        return Math.Floor(netZar / netMinutes * 10_000m) / 10_000m;
    }

    /// <summary>
    /// The rand a ledger row moved, signed the way its minutes are.
    ///
    /// <para>
    /// <c>ZarPaid</c> records what the member actually paid and is populated on funding and
    /// reversal rows. Its stored sign cannot be relied on — <c>PaymentReversal</c> has no
    /// producer yet, so no convention has been set by real data — while the minutes amount's
    /// sign is load-bearing everywhere else in this file. Taking the direction from the
    /// minutes keeps a reversal subtracting from revenue whichever way the rand figure is
    /// eventually written.
    /// </para>
    /// </summary>
    private static decimal SignedZar(LedgerEntry e)
    {
        var rand = Math.Abs(e.ZarPaid ?? 0m);
        return e.AmountMinutes < 0 ? -rand : rand;
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

    private static IEnumerable<DateOnly> EnumerateDays(DateOnly first, DateOnly last)
    {
        for (var d = first; d <= last; d = d.AddDays(1)) { yield return d; }
    }

    /// <summary>
    /// The club days a report covers, and the UTC window that holds exactly those days.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A report window is a run of the club's own calendar days, not a run of UTC
    /// hours.</b> The day BUCKETS were cut in <c>tenant_settings.timezone</c> while the
    /// WINDOW stayed in UTC, so the two disagreed at both ends. The page asks for
    /// <c>from=2026-09-01T00:00:00Z&amp;to=2026-09-03T23:59:59Z</c>; against a club at UTC+2
    /// that window opened two hours into 1 September local, dropping every movement between
    /// 00:00 and 02:00 on the first day — the exact band the bucket fix was written for, now
    /// missing from the report altogether rather than landing a day early — and it closed two
    /// hours into 4 September local, so a FOURTH row appeared carrying money from a day the
    /// admin had not asked about, and the totals card read "Days 4" for a three-day range.
    /// </para>
    /// <para>
    /// So the two boundary parameters are read as <b>day markers</b>: the UTC calendar date
    /// each instant names. That is what the date pickers send (<c>T00:00:00Z</c> and
    /// <c>T23:59:59Z</c> on the two chosen dates) and what an admin means by "1 September to
    /// 3 September" — and, unlike converting the marker through the club's zone, it names the
    /// same two dates whether the club is east or west of UTC. Those dates are then converted
    /// back into the one UTC window that contains exactly those club days, and every row
    /// filter and the day enumeration are driven from it. A movement is in the report if and
    /// only if it falls on a club day the report covers.
    /// </para>
    /// <para>
    /// <b>What that costs, said out loud, because it widened the contract.</b> The day either
    /// marker names is covered <b>in full</b>, so <c>to=2026-03-06T00:00:00Z</c> — an
    /// exclusive midnight, which is what a caller reading <c>to</c> as an INSTANT means by it
    /// — takes in the whole of 6 March rather than stopping at its first second. Both shapes
    /// the page can send therefore name the same window, and there is no shape of <c>to</c>
    /// that asks for part of a day. That is the contract, it is stated for callers in
    /// <c>docs/specs/reporting.md</c> § The report window, and both directions of it are
    /// pinned by <c>ReportWindowTests</c> — on this endpoint and on the five others that
    /// reach this helper, none of which had a range test before.
    /// </para>
    /// </remarks>
    private static (DateOnly First, DateOnly Last, DateTimeOffset Start, DateTimeOffset End)
        ResolveWindow(DateTimeOffset? from, DateTimeOffset? to, TimeZoneInfo tz)
    {
        var last = to is { } t ? DateOnly.FromDateTime(t.UtcDateTime) : LocalDay(DateTimeOffset.UtcNow, tz);
        var first = from is { } f ? DateOnly.FromDateTime(f.UtcDateTime) : last.AddDays(-30);
        // An inverted range is one day rather than a negative one: `EnumerateDays` would
        // yield nothing and every total would read zero, which looks like a quiet period.
        if (last < first) { last = first; }
        return (first, last, ClubDayStart(first, tz), ClubDayStart(last.AddDays(1), tz));
    }

    /// <summary>
    /// The instant a club day begins, as UTC.
    /// </summary>
    /// <remarks>
    /// Midnight is not a safe assumption in either direction. Some zones move the clock AT
    /// midnight — Santiago and Havana both do — so 00:00 either does not exist on the day
    /// the clocks go forward, or happens twice on the day they go back. The first case is
    /// stepped past; the second takes the EARLIER of the two instants, so the window covers
    /// the whole of the club's day rather than silently dropping its first hour.
    ///
    /// <para>
    /// Returned as UTC, and that is not cosmetic: Npgsql refuses to write or compare a
    /// <c>DateTimeOffset</c> whose offset is not zero against a <c>timestamptz</c> column, so
    /// a boundary still carrying the club's own <c>+02:00</c> throws out of the middle of the
    /// report query rather than returning a wrong answer. Same instant, offset normalised.
    /// </para>
    /// </remarks>
    private static DateTimeOffset ClubDayStart(DateOnly day, TimeZoneInfo tz)
    {
        var local = day.ToDateTime(TimeOnly.MinValue);
        while (tz.IsInvalidTime(local)) { local = local.AddMinutes(1); }
        var offset = tz.IsAmbiguousTime(local)
            ? tz.GetAmbiguousTimeOffsets(local).Max()
            : tz.GetUtcOffset(local);
        return new DateTimeOffset(local, offset).ToUniversalTime();
    }

    /// <summary>The tenant's zone, read once per request.</summary>
    private static async Task<TimeZoneInfo> ClubZoneAsync(TenantSettingsAccessor settings, CancellationToken ct)
        => ResolveTz((await settings.GetAsync(ct)).Timezone);

    /// <summary>
    /// The member's own period summary.
    ///
    /// <para>
    /// <b>It must reconcile.</b> It reported top-ups, spend, refunds and a penalty count and
    /// nothing else, so a member whose ledger held 2,500 minutes of admin adjustments read
    /// "0 in, 950 out, 100 back" on a page whose header said 1,635 — the two screens
    /// disagreeing with no way to see why. Every bucket a movement can land in is now here,
    /// and <c>net_movement_minutes</c> is their sum: for a range covering the whole ledger
    /// it equals the balance, and for any other range it is exactly what the balance moved
    /// by. <c>penalties_minutes</c> is the total <c>reporting.md</c> asks for beside the
    /// count it already had.
    /// </para>
    /// </summary>
    /// <summary>
    /// R11 J11-4: minutes the desk handed over for no rand — an <see cref="LedgerEntryType.AdminTopUp"/>
    /// with <c>ZarPaid</c> 0 (<c>package_free</c>, or a sale recorded at R0.00). The wallet called a
    /// free package "Bought"; this is the figure that lets it say "Given by the club".
    /// </summary>
    internal static int GivenMinutes(IEnumerable<LedgerEntry> entries) =>
        entries.Where(IsGiven).Sum(e => e.AmountMinutes);

    /// <summary>One desk top-up the club took no rand for — given, never sold (J11-4, R13 J13-2).</summary>
    private static bool IsGiven(LedgerEntry e) => e.Type == LedgerEntryType.AdminTopUp && e.ZarPaid == 0m;

    internal static object BuildWalletReport(
        List<LedgerEntry> entries, DateTimeOffset from, DateTimeOffset to,
        int attendedBookings = 0, int minutesOnCourt = 0)
    {
        var topUps = entries.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.AmountMinutes);
        var spent = -entries.Where(e => LedgerEntryTypes.Spend.Contains(e.Type)).Sum(e => e.AmountMinutes);
        var refunds = entries.Where(e => LedgerEntryTypes.Refund.Contains(e.Type)).Sum(e => e.AmountMinutes);
        var penaltiesTotal = -entries.Where(e => LedgerEntryTypes.Penalty.Contains(e.Type)).Sum(e => e.AmountMinutes);
        var adjustments = entries.Where(e => LedgerEntryTypes.Adjustment.Contains(e.Type)).Sum(e => e.AmountMinutes);
        var reversals = entries.Where(e => LedgerEntryTypes.Reversal.Contains(e.Type)).Sum(e => e.AmountMinutes);
        // D11: shares paid to (−) or received from (+) other players for split bookings.
        var shares = entries.Where(e => LedgerEntryTypes.Transfer.Contains(e.Type)).Sum(e => e.AmountMinutes);
        // A penalty is a debit. A reversed no-show posts a positive row of the same type
        // to give the money back, and that row is not a second penalty — nor is the penalty it
        // gave back still one (review round 7, E7-7: "Penalty count 1" beside "Penalties 0 min"
        // after the club returned it). Counted per booking, on what its penalty rows net to.
        var penalties = PenaltyCount(entries);
        return new
        {
            from,
            to,
            top_ups_minutes = topUps,
            // R11 J11-4: the part of top_ups_minutes the club gave at no charge — a desk package
            // given free (or sold at R0.00). A SUBSET of top_ups_minutes, never added to the net.
            given_minutes = GivenMinutes(entries),
            spent_minutes = spent,
            refunds_minutes = refunds,
            penalties_minutes = penaltiesTotal,
            adjustments_minutes = adjustments,
            reversals_minutes = reversals,
            share_transfers_minutes = shares,
            // What court time actually cost this member once the players settled up: spend,
            // less refunds, plus penalties, less the shares others paid them (plus the shares
            // they paid others). The club's figures are unchanged; this is the member's own.
            net_court_spend_minutes = spent - refunds + penaltiesTotal - shares,
            net_movement_minutes = entries.Sum(e => e.AmountMinutes),
            penalty_count = penalties,
            attended_bookings = attendedBookings,
            minutes_on_court = minutesOnCourt,
            count = entries.Count,
        };
    }

    /// <summary>
    /// How many penalties this member is still out: one per booking whose penalty rows net to a
    /// debit, plus each unbooked penalty debit on its own. A penalty given back nets to nothing.
    /// </summary>
    internal static int PenaltyCount(IEnumerable<LedgerEntry> entries)
    {
        var rows = entries.Where(e => LedgerEntryTypes.Penalty.Contains(e.Type)).ToList();
        var booked = rows.Where(e => e.RelatedBookingId is not null)
            .GroupBy(e => e.RelatedBookingId)
            .Count(g => g.Sum(e => e.AmountMinutes) < 0);
        return booked + rows.Count(e => e.RelatedBookingId is null && e.AmountMinutes < 0);
    }

    private static string LedgerCsv(IEnumerable<LedgerEntry> entries)
    {
        var sb = new StringBuilder();
        sb.AppendLine("created_at,type,amount_minutes,reason,external_reference,related_booking_id");
        foreach (var e in entries)
        {
            sb.Append(e.CreatedAt.ToString("o", CultureInfo.InvariantCulture)).Append(',');
            sb.Append(e.Type).Append(',');
            sb.Append(e.AmountMinutes.ToString(CultureInfo.InvariantCulture)).Append(',');
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
