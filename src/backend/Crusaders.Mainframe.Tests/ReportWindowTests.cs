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
/// What <c>from</c> and <c>to</c> mean, on every endpoint that takes them.
/// </summary>
/// <remarks>
/// <para>
/// <b>The contract, stated.</b> Both parameters are <b>day markers</b>: the UTC calendar date
/// each instant names, and nothing else about it. The report covers every one of the club's
/// own calendar days from <c>from</c>'s date to <c>to</c>'s date <b>inclusive</b>, and the UTC
/// window handed to the queries is the one that holds exactly those days. It is written out
/// where a caller reads it, in <c>docs/specs/reporting.md</c> § The report window.
/// </para>
/// <para>
/// <b>Why this file exists.</b> The contract WIDENED without anyone saying so.
/// <c>to=2026-03-06T00:00:00Z</c> — an exclusive midnight, which is what "up to the 6th" means
/// to anyone reading it as an instant — stopped at that midnight before the day-marker fix and
/// now takes in the whole of 6 March. That is a defensible reading and it is the one chosen,
/// but the two pre-existing tests that send exactly that URL
/// (<c>DailyReportTests.Daily_buckets_on_the_clubs_own_day_not_the_servers</c> and
/// <c>…keeps_money_and_play_on_their_own_clocks</c>) are green under BOTH readings, because
/// their fixture seeds nothing at all on the last day. The change was invisible to the suite.
/// So the last day is loaded here, deliberately, and pinned in both directions: everything on
/// it is in, and everything on the day after it is out.
/// </para>
/// <para>
/// <b>And the surfaces nobody was driving.</b> Six endpoints read the same window helper and
/// only <c>/admin/reports/daily</c> was ever sent a range. Reverting <c>/reports/me/daily</c>
/// alone to the pre-fix window left the entire backend suite green, and no test anywhere put a
/// <c>from</c>/<c>to</c> on <c>/wallet</c>, <c>/wallet.csv</c>, <c>/revenue</c>,
/// <c>/utilisation</c> or <c>/no-shows</c> — <c>RevenueUnitTests</c> is the only caller of any
/// of them and it sends no query string. Each gets the same two-sided probe here, so a window
/// that regresses on one endpoint cannot hide behind another.
/// </para>
/// </remarks>
public sealed class ReportWindowTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public ReportWindowTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    /// <summary>Africa/Johannesburg is UTC+2 year round — no DST to reason about.</summary>
    private const string ClubZone = "Africa/Johannesburg";

    private static readonly DateOnly First = new(2026, 3, 1);
    private static readonly DateOnly Last = new(2026, 3, 6);

    /// <summary>
    /// The URL under test, byte for byte: an EXCLUSIVE midnight on the last day. Read as an
    /// instant it excludes the whole of 6 March; read as a day marker, which is the contract,
    /// it includes it.
    /// </summary>
    private const string Range = "from=2026-03-01T00:00:00Z&to=2026-03-06T00:00:00Z";

    // The four probes every assertion below is built from. Amounts are distinct so a figure
    // landing in the wrong bucket, or a row landing on the wrong day, reads as itself.
    private const decimal DayBeforeCredits = 111m;   // 2026-02-28, outside on the `from` side
    private const decimal FirstInstantCredits = 22m; // 2026-03-01 00:00:00 club, the first second in
    private const decimal LastDayCredits = 777m;     // 2026-03-06 10:00 club, the day `to` names
    private const decimal DayAfterCredits = 999m;    // 2026-03-07 10:00 club, outside on the `to` side

    private const decimal LastDayTopUpCredits = 300m;
    private const decimal LastDayTopUpZar = 187.50m;
    private const decimal DayAfterTopUpCredits = 500m;
    private const decimal DayAfterTopUpZar = 312.50m;

    private const string DayBeforeReason = "on the day before the range";
    private const string FirstInstantReason = "at the first instant of the range";
    private const string LastDayReason = "on the last day of the range";
    private const string DayAfterReason = "on the day after the range";

    /// <summary>
    /// <c>/admin/reports/daily</c>: the last day is a row, it carries the money, and the day
    /// after it is not a row at all.
    /// </summary>
    /// <remarks>
    /// Four zones rather than the club's own, because the one fixture field that could be
    /// carrying this result is the timezone and a single-zone probe cannot tell "the club's
    /// days" from "a constant shift". UTC is the control; Johannesburg is what Crusaders
    /// runs on; New York is WEST of UTC, where the last day's 10:00 probe sits at 15:00Z on
    /// the very date <c>to</c> names; Kathmandu is +05:45, so nothing working in whole hours
    /// can pass. All four were run before this remark was written.
    /// </remarks>
    [SkippableTheory]
    [InlineData("UTC")]
    [InlineData(ClubZone)]
    [InlineData("America/New_York")]
    [InlineData("Asia/Kathmandu")]
    public async Task An_exclusive_midnight_to_takes_in_the_whole_of_the_day_it_names(string timezone)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory, timezone);
        using var client = Client(factory, seed, admin: true);

        using var doc = await GetJsonAsync(client, $"/api/v1/admin/reports/daily?{Range}");
        var rows = doc.RootElement.EnumerateArray().ToList();

        // The row count first. Under the pre-fix reading the window closed at 2026-03-06
        // 00:00Z, which is 02:00 local, so the last row would have been a stub carrying two
        // hours of a day the admin asked for in full.
        Assert.Equal(
            new[]
            {
                "2026-03-01", "2026-03-02", "2026-03-03",
                "2026-03-04", "2026-03-05", "2026-03-06",
            },
            rows.Select(r => r.GetProperty("date").GetString()).ToArray());

        var byDate = rows.ToDictionary(r => r.GetProperty("date").GetString()!);
        decimal Adjustments(string date) => byDate[date].GetProperty("adjustments_credits").GetDecimal();

        // IN: a movement at 10:00 on the day `to` names, which no reading of `to` as an
        // instant would have included.
        Assert.Equal(LastDayCredits, Adjustments("2026-03-06"));
        Assert.Equal(LastDayTopUpCredits, byDate["2026-03-06"].GetProperty("top_ups_credits").GetDecimal());
        // IN: the first instant of the first club day.
        Assert.Equal(FirstInstantCredits, Adjustments("2026-03-01"));

        // OUT, both sides, asserted as a SUM so a row appearing anywhere with the excluded
        // money in it fails here even if the date list above were relaxed.
        Assert.Equal(
            FirstInstantCredits + LastDayCredits,
            rows.Sum(r => r.GetProperty("adjustments_credits").GetDecimal()));

        // And the sentence reporting.md makes out of all this: the two shapes of `to` a
        // caller can write for the same date name the SAME window. The page sends the
        // second one, so without this the two readings could drift apart with only the
        // unused half going red.
        using var inclusive = await GetJsonAsync(
            client, $"/api/v1/admin/reports/daily?from={First:yyyy-MM-dd}T00:00:00Z&to={Last:yyyy-MM-dd}T23:59:59Z");
        Assert.Equal(doc.RootElement.GetRawText(), inclusive.RootElement.GetRawText());
    }

    /// <summary>
    /// <c>/reports/me/daily</c> — the member's own half of the same fix, which nothing pinned.
    /// </summary>
    /// <remarks>
    /// Reverting this one endpoint to the pre-fix window (<c>from</c>/<c>to</c> used as raw
    /// UTC instants) left the entire backend suite green. Same probe as the club's report
    /// above, so the two cannot drift apart in silence either.
    /// </remarks>
    [SkippableFact]
    public async Task The_members_own_daily_report_covers_the_same_club_days_as_the_clubs()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory);
        using var client = Client(factory, seed, admin: false);

        using var doc = await GetJsonAsync(client, $"/api/v1/reports/me/daily?{Range}");
        var rows = doc.RootElement.EnumerateArray().ToList();

        Assert.Equal(
            new[]
            {
                "2026-03-01", "2026-03-02", "2026-03-03",
                "2026-03-04", "2026-03-05", "2026-03-06",
            },
            rows.Select(r => r.GetProperty("date").GetString()).ToArray());

        var byDate = rows.ToDictionary(r => r.GetProperty("date").GetString()!);

        // The top-up on the last day is in.
        Assert.Equal(LastDayTopUpCredits, byDate["2026-03-06"].GetProperty("top_ups_credits").GetDecimal());
        // And the booking played on the last day is in, on the row for that day.
        Assert.Equal(1, byDate["2026-03-06"].GetProperty("bookings").GetInt32());
        Assert.Equal(0, byDate["2026-03-05"].GetProperty("bookings").GetInt32());

        // The running balance is the whole-report check: it starts from everything BEFORE
        // the window (the 111.00 the day before) and ends having taken in every probe inside
        // it and none outside. A window that reached into 7 March would end 999.00 + 500.00
        // higher; one that stopped at midnight on the 6th would end 777.00 + 300.00 lower.
        Assert.Equal(
            DayBeforeCredits + FirstInstantCredits + LastDayCredits + LastDayTopUpCredits,
            rows[^1].GetProperty("balance_credits").GetDecimal());
    }

    // ---- The five surfaces that had no range test at all ----
    //
    // One test each, deliberately, rather than one test with five sections. A single
    // combined test goes red on the FIRST assertion that fails, so four of the five could
    // have been vacuous and nothing would ever have said so. Split, one window mutation
    // reds all five and each one is shown to be carrying its own weight.

    /// <summary>The window every one of them echoes back: 2026-03-01 to 2026-03-06, club days.</summary>
    private static readonly DateTimeOffset WindowStart = new(2026, 2, 28, 22, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset WindowEnd = new(2026, 3, 6, 22, 0, 0, TimeSpan.Zero);

    private static void AssertWindow(JsonElement root)
    {
        Assert.Equal(WindowStart, root.GetProperty("from").GetDateTimeOffset());
        // The START of the day after the last club day — 2026-03-07 00:00 in Johannesburg.
        Assert.Equal(WindowEnd, root.GetProperty("to").GetDateTimeOffset());
    }

    /// <summary><c>/reports/me/wallet</c> — the member's totals for the range.</summary>
    [SkippableFact]
    public async Task The_wallet_report_covers_the_club_days_the_range_names()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory);
        using var member = Client(factory, seed, admin: false);

        using var wallet = await GetJsonAsync(member, $"/api/v1/reports/me/wallet?{Range}");
        AssertWindow(wallet.RootElement);

        // Three rows in, five seeded. The last day's two are the ones that decide it.
        Assert.Equal(3, wallet.RootElement.GetProperty("count").GetInt32());
        Assert.Equal(
            FirstInstantCredits + LastDayCredits + LastDayTopUpCredits,
            wallet.RootElement.GetProperty("net_movement_credits").GetDecimal());
        Assert.Equal(LastDayTopUpCredits, wallet.RootElement.GetProperty("top_ups_credits").GetDecimal());
        Assert.Equal(FirstInstantCredits + LastDayCredits, wallet.RootElement.GetProperty("adjustments_credits").GetDecimal());
    }

    /// <summary>
    /// <c>/reports/me/wallet.csv</c> — the same rows, and the filename, which is built from
    /// the club's own first and last day rather than from the UTC window's edges.
    /// </summary>
    [SkippableFact]
    public async Task The_wallet_csv_holds_the_club_days_its_own_filename_claims()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory);
        using var member = Client(factory, seed, admin: false);

        var response = await member.GetAsync($"/api/v1/reports/me/wallet.csv?{Range}");
        response.EnsureSuccessStatusCode();
        var csv = await response.Content.ReadAsStringAsync();

        Assert.Contains(
            $"crusaders-mainframe_wallet_{First:yyyy-MM-dd}-{Last:yyyy-MM-dd}.csv",
            response.Content.Headers.ContentDisposition!.ToString());

        // The file says 1-6 March; these are the rows that make that true or false.
        Assert.Contains(FirstInstantReason, csv);
        Assert.Contains(LastDayReason, csv);
        Assert.DoesNotContain(DayBeforeReason, csv);
        Assert.DoesNotContain(DayAfterReason, csv);
    }

    /// <summary>
    /// <c>/admin/reports/revenue</c> — rand and credits both, since the two are read off
    /// different columns and a window that slipped would move them together.
    /// </summary>
    [SkippableFact]
    public async Task The_revenue_report_counts_the_last_days_top_up_and_not_the_next_days()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory);
        using var admin = Client(factory, seed, admin: true);

        using var revenue = await GetJsonAsync(admin, $"/api/v1/admin/reports/revenue?{Range}");
        AssertWindow(revenue.RootElement);

        Assert.Equal(LastDayTopUpCredits, revenue.RootElement.GetProperty("gross_topups_credits").GetDecimal());
        Assert.Equal(LastDayTopUpZar, revenue.RootElement.GetProperty("gross_topups_zar").GetDecimal());
        Assert.Equal(LastDayTopUpCredits, revenue.RootElement.GetProperty("net_credits").GetDecimal());
    }

    /// <summary>
    /// <c>/admin/reports/utilisation</c> — bookings are windowed on <c>StartsAt</c>, so the
    /// last day's court is in and the day after's is not.
    /// </summary>
    [SkippableFact]
    public async Task The_utilisation_report_counts_the_last_days_court_and_not_the_next_days()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory);
        using var admin = Client(factory, seed, admin: true);

        using var utilisation = await GetJsonAsync(admin, $"/api/v1/admin/reports/utilisation?{Range}");
        AssertWindow(utilisation.RootElement);

        var court = Assert.Single(utilisation.RootElement.GetProperty("by_court").EnumerateArray().ToList());
        Assert.Equal(1, court.GetProperty("bookings").GetInt32());
        Assert.Equal(30, court.GetProperty("booked_minutes").GetInt32());
    }

    /// <summary>
    /// <c>/admin/reports/no-shows</c> — the same two bookings, and the denominator is the
    /// half that moves. Both started in the past, so only the window separates them.
    /// </summary>
    [SkippableFact]
    public async Task The_no_show_report_judges_the_last_days_booking_and_not_the_next_days()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory);
        using var admin = Client(factory, seed, admin: true);

        using var noShows = await GetJsonAsync(admin, $"/api/v1/admin/reports/no-shows?{Range}");
        AssertWindow(noShows.RootElement);

        // One booking in the window and it was a no-show; the day after's Booked one would
        // halve this percentage if the window reached it.
        Assert.Equal(1, noShows.RootElement.GetProperty("total").GetInt32());
        Assert.Equal(1, noShows.RootElement.GetProperty("no_show").GetInt32());
        Assert.Equal(100.0, noShows.RootElement.GetProperty("no_show_pct").GetDouble());
    }

    /// <summary>
    /// No range at all: the window runs to the END of the club's current day, which is in
    /// the future.
    /// </summary>
    /// <remarks>
    /// This is the one clause of the contract that is genuinely surprising, and it had no
    /// test. Before the day-marker fix a missing <c>to</c> meant <c>now</c>; it now means the
    /// club's current day, covered in full, so the window reaches up to 24 hours ahead. That
    /// inflates <c>/no-shows</c>' denominator and <c>/utilisation</c>'s booked minutes with
    /// bookings that have not happened yet. Nothing in the app calls these without a range —
    /// <c>RevenueUnitTests</c> is the only caller that does and it is insensitive to it — so
    /// this is written down in <c>reporting.md</c> and pinned rather than changed.
    /// </remarks>
    [SkippableFact]
    public async Task A_report_with_no_range_runs_to_the_end_of_the_clubs_current_day()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seed = await SeedAsync(factory);
        using var admin = Client(factory, seed, admin: true);

        var before = DateTimeOffset.UtcNow;
        using var doc = await GetJsonAsync(admin, "/api/v1/admin/reports/revenue");
        var to = doc.RootElement.GetProperty("to").GetDateTimeOffset();
        var from = doc.RootElement.GetProperty("from").GetDateTimeOffset();

        // Ahead of now, and by less than a whole day. Asserted as an inequality rather than
        // against a recomputed instant, which would only repeat the production arithmetic.
        Assert.True(to > before, $"window ends at {to:o}, which is not past {before:o}");
        Assert.True(to - before < TimeSpan.FromHours(24), $"window ends at {to:o}, more than a day past {before:o}");

        // And it opens at the start of the club day 30 days back, so the window spans 31
        // club days. Exact because this club's zone has no DST — see ClubZone above.
        Assert.Equal(TimeSpan.Zero, to - from - TimeSpan.FromDays(31));
    }

    private static async Task<JsonDocument> GetJsonAsync(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
    }

    /// <summary>The instant a club wall-clock time falls on, as UTC.</summary>
    private static DateTimeOffset ClubTime(DateOnly day, int hour, int minute, string timezone)
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(timezone);
        var local = day.ToDateTime(new TimeOnly(hour, minute));
        return new DateTimeOffset(local, tz.GetUtcOffset(local)).ToUniversalTime();
    }

    private sealed record Seed(Guid TenantId, string Slug, Guid AdminId, Guid MemberId);

    private static HttpClient Client(TestWebAppFactory factory, Seed seed, bool admin)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer", Jwt(seed, admin ? seed.AdminId : seed.MemberId, admin));
        return client;
    }

    private static async Task<Seed> SeedAsync(TestWebAppFactory factory, string timezone = ClubZone)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"win-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Window Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson =
                $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"{{timezone}}"}""",
        });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m };
        db.Courts.Add(court);

        void Adjustment(DateTimeOffset at, decimal credits, string reason) =>
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.AdminAdjustment,
                AmountCredits = credits, ActorUserId = admin.Id, Reason = reason, CreatedAt = at,
            });

        void TopUp(DateTimeOffset at, decimal credits, decimal zar, string reason) =>
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.TopUp,
                AmountCredits = credits, ZarPaid = zar, ConversionRate = 1.6m,
                ActorUserId = member.Id, Reason = reason, CreatedAt = at,
            });

        void Booking(DateTimeOffset startsAt, BookingStatus status) =>
            db.Bookings.Add(new Booking
            {
                TenantId = tenant.Id, CourtId = court.Id, UserId = member.Id,
                BookedByUserId = member.Id, PaidByUserId = member.Id, ActorUserId = member.Id,
                StartsAt = startsAt, EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 30, SliceCount = 1, AmountChargedCredits = 16m,
                Status = status, ChargedAt = startsAt.AddDays(-1),
            });

        // Outside, on the `from` side. It is also what seeds the member report's running
        // balance, so its absence from the rows and its presence in the opening figure are
        // asserted by the same number.
        Adjustment(ClubTime(First.AddDays(-1), 10, 0, timezone), DayBeforeCredits, DayBeforeReason);
        // The first instant of the first club day — 00:00 local, which is 22:00Z the evening
        // before and is the edge the `from` half of the fix was written for.
        Adjustment(ClubTime(First, 0, 0, timezone), FirstInstantCredits, FirstInstantReason);
        // The day `to` names, loaded. This is the whole point of the file: the two
        // pre-existing tests that send this URL seed nothing here.
        Adjustment(ClubTime(Last, 10, 0, timezone), LastDayCredits, LastDayReason);
        TopUp(ClubTime(Last, 10, 30, timezone), LastDayTopUpCredits, LastDayTopUpZar, LastDayReason + " (top-up)");
        Booking(ClubTime(Last, 9, 0, timezone), BookingStatus.NoShow);
        // The day after, which must be in nothing.
        Adjustment(ClubTime(Last.AddDays(1), 10, 0, timezone), DayAfterCredits, DayAfterReason);
        TopUp(ClubTime(Last.AddDays(1), 10, 30, timezone), DayAfterTopUpCredits, DayAfterTopUpZar, DayAfterReason + " (top-up)");
        Booking(ClubTime(Last.AddDays(1), 9, 0, timezone), BookingStatus.Booked);

        await db.SaveChangesAsync();
        return new Seed(tenant.Id, slug, admin.Id, member.Id);
    }

    private static string Jwt(Seed seed, Guid userId, bool admin)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new("tenant_id", seed.TenantId.ToString()),
            new("tenant_slug", seed.Slug),
            new("purpose", "access"),
        };
        if (admin) claims.Add(new Claim(ClaimTypes.Role, "admin"));
        return new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256)));
    }
}
