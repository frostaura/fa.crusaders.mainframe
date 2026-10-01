using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The club's daily breakdown: which day a figure lands on, and which figures are there.
///
/// <para>
/// Two defects, both visible on one screen. The buckets were cut on
/// <c>DateOnly.FromDateTime(x.UtcDateTime)</c> while the club runs
/// <c>Africa/Johannesburg</c>, so every movement between 00:00 and 02:00 local fell into the
/// previous day's row — and on the 1st of a month, into the previous month's report.
/// <c>reporting.md</c> § Implementation notes has required the tenant's own timezone since
/// it was written. And the row carried no <b>adjustments</b> figure at all: a club that had
/// handed out 2,525.50 credits at the desk could read that number on a member's own report
/// and on Transactions, and on no screen describing the club.
/// </para>
///
/// <para>
/// The third assertion here is not a defect but the thing that made the first one hard to
/// see: a row deliberately mixes two date bases — money on the day it moved, courts on the
/// day they are played — and under a 14-day advance window those are routinely different
/// days. That is pinned deliberately so a later "tidy-up" that quietly re-buckets bookings
/// onto the ledger's clock has to argue with a test rather than with a reviewer.
/// </para>
/// </summary>
public sealed class DailyReportTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DailyReportTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    /// <summary>Africa/Johannesburg is UTC+2 year round — no DST to reason about.</summary>
    private const string ClubZone = "Africa/Johannesburg";

    [SkippableTheory]
    // The club's zone, and UTC as the control. The SAME two instants must land on two days
    // under the first and on one day under the second, or the endpoint is not reading the
    // setting at all — a fixture that only ever ran at +02:00 could be satisfied by any
    // constant shift, including none.
    [InlineData(ClubZone, "2026-03-03")]
    [InlineData("UTC", "2026-03-02")]
    public async Task Daily_buckets_on_the_clubs_own_day_not_the_servers(
        string timezone, string expectedTopUpDay)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;

        // 22:30Z is 00:30 the NEXT day in Johannesburg; 21:30Z is 23:30 the SAME day. One
        // instant either side of the club's midnight, so a fix that shifts every row by a
        // day fails as loudly as the bug did.
        var lateNight = new DateTimeOffset(2026, 3, 2, 22, 30, 0, TimeSpan.Zero);
        var evening = new DateTimeOffset(2026, 3, 2, 21, 30, 0, TimeSpan.Zero);

        var (tenantId, slug, adminId) = await SeedAsync(factory, timezone, lateNight, evening);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Jwt(tenantId, slug, adminId));

        // `to` is a day marker, so this covers the whole of 6 March. Nothing is seeded on
        // it, which is why this test is insensitive to that end of the window — the
        // exclusive-midnight shape is pinned in both directions by ReportWindowTests.
        var response = await client.GetAsync(
            "/api/v1/admin/reports/daily?from=2026-03-01T00:00:00Z&to=2026-03-06T00:00:00Z");
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var byDate = doc.RootElement.EnumerateArray().ToDictionary(e => e.GetProperty("date").GetString()!);

        // The 300-credit top-up sits on the club's day, and on no other day — asserting the
        // whole series rather than one cell, so a fix that duplicates a row across two
        // buckets fails here too.
        foreach (var (date, row) in byDate)
        {
            var expected = date == expectedTopUpDay ? 300 : 0;
            Assert.Equal(expected, row.GetProperty("top_ups_minutes").GetDecimal());
        }

        // The 50-credit charge is an hour earlier and stays on 2 March under BOTH zones. So
        // in Johannesburg the two rows are split by the club's midnight, and in UTC they are
        // not — which is the whole difference between the two cases.
        Assert.Equal(50m, byDate["2026-03-02"].GetProperty("booking_charges_minutes").GetDecimal());
    }

    [SkippableFact]
    public async Task Daily_reports_what_the_desk_adjusted_and_keeps_money_and_play_on_their_own_clocks()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;

        var lateNight = new DateTimeOffset(2026, 3, 2, 22, 30, 0, TimeSpan.Zero);
        var evening = new DateTimeOffset(2026, 3, 2, 21, 30, 0, TimeSpan.Zero);
        var (tenantId, slug, adminId) = await SeedAsync(factory, ClubZone, lateNight, evening);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Jwt(tenantId, slug, adminId));

        // `to` is a day marker, so this covers the whole of 6 March. Nothing is seeded on
        // it, which is why this test is insensitive to that end of the window — the
        // exclusive-midnight shape is pinned in both directions by ReportWindowTests.
        var response = await client.GetAsync(
            "/api/v1/admin/reports/daily?from=2026-03-01T00:00:00Z&to=2026-03-06T00:00:00Z");
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var byDate = doc.RootElement.EnumerateArray().ToDictionary(e => e.GetProperty("date").GetString()!);

        // K-F10: the desk's own movements, on the club's report, at all.
        Assert.Equal(125, byDate["2026-03-03"].GetProperty("adjustments_minutes").GetDecimal());
        // A day with none reads zero rather than being absent — the charts index every day.
        Assert.Equal(0m, byDate["2026-03-05"].GetProperty("adjustments_minutes").GetDecimal());

        // The two clocks, stated. The court is charged for on the 2nd (local) and played on
        // the 4th, so the money column and the courts column of one row are not about the
        // same booking — which is exactly what the screen now says under the table.
        Assert.Equal(50m, byDate["2026-03-02"].GetProperty("booking_charges_minutes").GetDecimal());
        Assert.Equal(0, byDate["2026-03-02"].GetProperty("bookings").GetInt32());
        Assert.Equal(0m, byDate["2026-03-04"].GetProperty("booking_charges_minutes").GetDecimal());
        Assert.Equal(1, byDate["2026-03-04"].GetProperty("bookings").GetInt32());
    }

    /// <summary>
    /// The window, at both ends, in the club's own days.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The buckets were cut in <c>tenant_settings.timezone</c> and the WINDOW was left in
    /// UTC, so the report's two halves disagreed at both edges. Against the exact URL the
    /// page sends — <c>from=&lt;first&gt;T00:00:00Z&amp;to=&lt;last&gt;T23:59:59Z</c> — a club at
    /// UTC+2 lost every movement between 00:00 and 02:00 on the first day, the same band the
    /// bucket fix had been written for, and gained a FOURTH row dated the day after the range
    /// carrying money the admin never asked to see. The totals card then read "Days 4" for a
    /// three-day range.
    /// </para>
    /// <para>
    /// The old pin could not see either half, and that is half of what this replaces. Its
    /// instants were 22:30Z and 21:30Z on 2 March, both comfortably INSIDE a 1-6 March
    /// window, so no assertion touched a boundary; and its loop
    /// (<c>expected = date == expectedTopUpDay ? 300 : 0</c>) is satisfied by a spurious
    /// zero-valued trailing day, so an extra row was invisible to it. This one pins the first
    /// instant of the first club day, the last instant of the last, one instant either side
    /// of them, and the row COUNT.
    /// </para>
    /// <para>
    /// Four zones, because the rule is "the club's configured days" and not "a shift". UTC is
    /// the control; Johannesburg is what Crusaders runs on; New York is WEST of UTC, where a
    /// window that reads its boundaries through the club's clock breaks the other way; and
    /// Kathmandu is +05:45, so nothing that works by whole hours can pass.
    /// </para>
    /// </remarks>
    [SkippableTheory]
    [InlineData("UTC")]
    [InlineData(ClubZone)]
    [InlineData("America/New_York")]
    [InlineData("Asia/Kathmandu")]
    public async Task Daily_covers_the_clubs_own_days_and_only_those(string timezone)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var tz = TimeZoneInfo.FindSystemTimeZoneById(timezone);

        // Five probes, all written as CLUB wall-clock times, which is the only clock the
        // admin picking two dates is thinking in.
        var first = new DateOnly(2026, 9, 1);
        var last = new DateOnly(2026, 9, 3);
        var probes = new (string Label, DateTimeOffset At, int Credits)[]
        {
            ("the day before, at 23:30", ClubTime(first.AddDays(-1), 23, 30, 0, tz), 99),
            ("the first instant of the first day", ClubTime(first, 0, 0, 0, tz), 11),
            ("00:30 on the first day", ClubTime(first, 0, 30, 0, tz), 111),
            ("the last instant of the last day", ClubTime(last, 23, 59, 59, tz), 13),
            ("00:30 on the day after", ClubTime(last.AddDays(1), 0, 30, 0, tz), 222),
        };

        var (tenantId, slug, adminId) = await SeedProbesAsync(factory, timezone, probes);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Jwt(tenantId, slug, adminId));

        // Byte for byte what Reports.tsx sends for a 1-3 September range.
        var response = await client.GetAsync(
            $"/api/v1/admin/reports/daily?from={first:yyyy-MM-dd}T00:00:00Z&to={last:yyyy-MM-dd}T23:59:59Z");
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var rows = doc.RootElement.EnumerateArray().ToList();

        // THE COUNT, which the old assertion loop could not see. A trailing day carrying
        // 222.00 was as acceptable to it as one carrying nothing.
        Assert.Equal(
            new[] { "2026-09-01", "2026-09-02", "2026-09-03" },
            rows.Select(r => r.GetProperty("date").GetString()).ToArray());

        var byDate = rows.ToDictionary(e => e.GetProperty("date").GetString()!);
        decimal Adjustments(string date) => byDate[date].GetProperty("adjustments_minutes").GetDecimal();

        // Both edges of the club's own days are inside, and nothing outside them is.
        Assert.Equal(122, Adjustments("2026-09-01"));   // 11.00 at 00:00:00 + 111.00 at 00:30
        Assert.Equal(0, Adjustments("2026-09-02"));
        Assert.Equal(13, Adjustments("2026-09-03"));    // 23:59:59, the club's last second
        // 99.00 the evening before and 222.00 the morning after are in no row at all, so the
        // three days sum to exactly what fell on them.
        Assert.Equal(135m, rows.Sum(r => r.GetProperty("adjustments_minutes").GetDecimal()));
    }

    /// <summary>
    /// Every ledger type the enum carries reaches a bucket on the CLUB's daily row.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>LedgerEntryTypeCoverageTests</c> asserts the bucket TABLE is total. It never
    /// asserts an endpoint uses all of it, and this one did not:
    /// <c>LedgerEntryType.PaymentReversal</c> was in no bucket of the club's daily row, under
    /// a card reading "top-ups - charges + refunds - penalties + adjustments, which is every
    /// ledger movement in the club summed". A -160.00 reversal inside the window made that
    /// card print +555.00 over a true movement of +395.00 — and the member's own report,
    /// which sums every type, disagreed with it by exactly the reversals.
    /// </para>
    /// <para>
    /// So this posts one row of EVERY member of <see cref="LedgerEntryType"/> — enumerated,
    /// not listed, so a member added tomorrow is posted tomorrow — and asserts the buckets
    /// add up to the type-blind total. Add a type and forget to bucket it here and this goes
    /// red naming the arithmetic, rather than the club's report quietly ceasing to sum to
    /// itself.
    /// </para>
    /// </remarks>
    [SkippableFact]
    public async Task Daily_buckets_account_for_every_ledger_type_there_is()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var tz = TimeZoneInfo.FindSystemTimeZoneById(ClubZone);
        var day = new DateOnly(2026, 9, 2);

        var types = Enum.GetValues<LedgerEntryType>();
        var probes = types
            .Select(t => (Label: t.ToString(), At: ClubTime(day, 12, 0, 0, tz), Credits: AmountFor(t)))
            .ToArray();

        var (tenantId, slug, adminId) = await SeedProbesAsync(factory, ClubZone, probes, types);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Jwt(tenantId, slug, adminId));

        var response = await client.GetAsync(
            "/api/v1/admin/reports/daily?from=2026-09-02T00:00:00Z&to=2026-09-02T23:59:59Z");
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        // Selected by date rather than by being the only row: this test is about the
        // BUCKETS, and a window defect belongs to the boundary test above, not here.
        var row = doc.RootElement.EnumerateArray()
            .Single(r => r.GetProperty("date").GetString() == "2026-09-02");
        decimal Get(string name) => row.GetProperty(name).GetDecimal();

        // The type-blind total first: it is what the member's own `net_movement_minutes`
        // means, and what the club's card now claims to print.
        var posted = probes.Sum(x => x.Credits);
        Assert.Equal(posted, Get("net_movement_minutes"));

        // And the buckets, which must be the same number by a different route. Charges and
        // penalties are reported as positive magnitudes, hence the subtractions — the same
        // arithmetic the card spells out under the figure.
        var bucketed = Get("top_ups_minutes") - Get("booking_charges_minutes") + Get("refunds_minutes")
            - Get("penalties_minutes") + Get("adjustments_minutes") + Get("reversals_minutes")
            + Get("share_transfers_minutes");
        Assert.True(
            bucketed == posted,
            $"The club's daily buckets sum to {bucketed} but {posted} moved. Some member of "
            + $"LedgerEntryType ({string.Join(", ", types)}) reaches no bucket on this row, so it "
            + "moves balances while being invisible in the club's report — the failure "
            + "LedgerEntryTypes was declared to prevent. Bucket it in ReportingEndpoints' "
            + "/daily row, and check the totals card's copy still tells the truth.");

        // The one that was actually missing, named, so a regression reads as itself.
        Assert.Equal(AmountFor(LedgerEntryType.PaymentReversal), Get("reversals_minutes"));
    }

    /// <summary>
    /// A distinct, non-zero amount per ledger type, signed the way that type moves money.
    /// Derived from the enum rather than listed, so a member added later gets one too — an
    /// amount of zero would let an unbucketed type pass the arithmetic.
    /// </summary>
    private static int AmountFor(LedgerEntryType type)
    {
        var magnitude = 10 + ((int)type * 3);
        var leavesTheWallet = LedgerEntryTypes.Spend.Contains(type)
            || LedgerEntryTypes.Penalty.Contains(type)
            || LedgerEntryTypes.Reversal.Contains(type);
        return leavesTheWallet ? -magnitude : magnitude;
    }

    /// <summary>
    /// The instant a club wall-clock time falls on, as UTC — which is how the ledger stores
    /// it, and the only offset Npgsql will write to a <c>timestamptz</c> column.
    /// </summary>
    private static DateTimeOffset ClubTime(DateOnly day, int hour, int minute, int second, TimeZoneInfo tz)
    {
        var local = day.ToDateTime(new TimeOnly(hour, minute, second));
        return new DateTimeOffset(local, tz.GetUtcOffset(local)).ToUniversalTime();
    }

    /// <summary>
    /// A club in <paramref name="timezone"/> whose ledger holds exactly the given rows.
    /// <paramref name="types"/> defaults to <c>AdminAdjustment</c> for every row, which is
    /// the bucket the boundary probes read out of.
    /// </summary>
    private static async Task<(Guid TenantId, string Slug, Guid AdminId)> SeedProbesAsync(
        TestWebAppFactory factory, string timezone,
        (string Label, DateTimeOffset At, int Credits)[] probes,
        LedgerEntryType[]? types = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"probe-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Probe Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"{{timezone}}"}""",
        });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);

        for (var i = 0; i < probes.Length; i++)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant.Id,
                UserId = member.Id,
                Type = types is null ? LedgerEntryType.AdminAdjustment : types[i],
                AmountMinutes = probes[i].Credits,
                ActorUserId = admin.Id,
                Reason = probes[i].Label,
                CreatedAt = probes[i].At,
            });
        }

        await db.SaveChangesAsync();
        return (tenant.Id, slug, admin.Id);
    }

    /// <summary>
    /// One club, one member, and four rows: a top-up just after the club's midnight, a
    /// booking charge just before it, a desk adjustment, and the booking those charges name
    /// — played two days after it was paid for.
    /// </summary>
    private static async Task<(Guid TenantId, string Slug, Guid AdminId)> SeedAsync(
        TestWebAppFactory factory, string timezone, DateTimeOffset lateNight, DateTimeOffset evening)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"daily-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Daily Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"{{timezone}}"}""",
        });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1" };
        db.Courts.Add(court);

        var booking = new Booking
        {
            TenantId = tenant.Id,
            CourtId = court.Id,
            UserId = member.Id,
            ActorUserId = member.Id,
            StartsAt = new DateTimeOffset(2026, 3, 4, 8, 0, 0, TimeSpan.Zero),
            EndsAt = new DateTimeOffset(2026, 3, 4, 8, 30, 0, TimeSpan.Zero),
            SliceMinutes = 30,
            SliceCount = 1,
            AmountChargedMinutes = 50,
            Status = BookingStatus.Booked,
        };
        db.Bookings.Add(booking);

        db.LedgerEntries.AddRange(
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.TopUp,
                AmountMinutes = 300, ZarPaid = 187.50m,
                ActorUserId = member.Id, Reason = "top-up just after midnight", CreatedAt = lateNight,
            },
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.BookingCharge,
                AmountMinutes = -50, RelatedBookingId = booking.Id,
                ActorUserId = member.Id, Reason = "court paid for two days ahead", CreatedAt = evening,
            },
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.AdminAdjustment,
                AmountMinutes = 125, ActorUserId = admin.Id, Reason = "goodwill",
                CreatedAt = new DateTimeOffset(2026, 3, 3, 10, 0, 0, TimeSpan.Zero),
            });

        await db.SaveChangesAsync();
        return (tenant.Id, slug, admin.Id);
    }

    private static string Jwt(Guid tenantId, string slug, Guid adminId)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, adminId.ToString()),
            new("tenant_id", tenantId.ToString()),
            new("tenant_slug", slug),
            new("purpose", "access"),
            new(ClaimTypes.Role, "admin"),
        };
        return new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256)));
    }
}
