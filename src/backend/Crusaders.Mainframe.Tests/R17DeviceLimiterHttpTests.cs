using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 17, lane BE17a, D17-1: a board's requests are not charged to the per-address bucket
/// anonymous visitors share.
///
/// <para>
/// R16 made the DEVICE policy per board, but the global backstop still put every request without a
/// member token — and a device request has none — into one bucket per client ADDRESS. A club's boards
/// and its members' phones sit behind one router, so a disabled box on bridge 2.2.5 re-posting its head
/// event (~50,000 a minute on the live stack) spent that bucket: every other board's heartbeat and an
/// anonymous <c>/auth/login</c> from the club were answered 429 for the rest of the minute
/// (r17d17/flood-run*.out). A device request with a recognised key is now charged to its BOARD's own
/// global bucket, and its board-passed traffic to a device-only per-address ceiling; anonymous traffic
/// keeps the address bucket to itself.
/// </para>
/// </summary>
public sealed class R17DeviceLimiterHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const int DeviceBudget = 5;
    private const int BoardGlobalBudget = 8;
    private const int AddressBudget = 12;
    private const int Flood = 40;

    private async Task<(MemberCodeClub Club, WebApplicationFactory<Program> App, HttpClient Http, TestWebAppFactory Host)> RigAsync(string prefix)
    {
        var host = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int>
            {
                ["DevicePerMinute"] = DeviceBudget,
                ["GlobalPerMinute"] = BoardGlobalBudget,
                ["GlobalPerIpPerMinute"] = AddressBudget,
            },
        };
        var app = MemberCodeClub.Wired(host, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        return (club, app, app.CreateClient(), host);
    }

    /// <summary>An anonymous sign-in from the same address: wrong password, so 401 — never 429.</summary>
    private static async Task<HttpStatusCode> AnonymousLoginAsync(MemberCodeClub club, WebApplicationFactory<Program> app)
    {
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        var response = await client.PostAsync("/api/v1/auth/login", new StringContent(
            new JsonObject { ["email"] = $"nobody-{club.Slug}@test.local", ["password"] = "wrong-password" }.ToJsonString(),
            Encoding.UTF8, "application/json"));
        return response.StatusCode;
    }

    private static async Task<string> AddBoxAsync(MemberCodeClub club, WebApplicationFactory<Program> app)
    {
        var mac = Guid.NewGuid().ToString("N")[..12];
        await club.WriteAsync(app, db =>
        {
            db.Devices.Add(new Device
            {
                TenantId = club.TenantId,
                DeviceCode = $"box-{mac[^6..]}",
                Name = "Box 2",
                Kind = DeviceKind.CourtBox,
                MacAddress = mac,
                CourtNumbers = [1, 2, 3, 4],
                AutoRegistered = false,
            });
            return Task.CompletedTask;
        });
        return mac;
    }

    /// <summary>
    /// One board far past every ceiling (disabled and spinning on 403, as the reviewer's 2.2.5 box; varied:
    /// enabled and spinning heartbeats): the other board — a door gate, varied a second court box — still
    /// checks in, an anonymous sign-in from the same address is still answered on its merits, and the
    /// flooding board itself is still 429.
    /// </summary>
    [SkippableTheory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task A_flooding_board_does_not_429_other_boards_or_anonymous_callers(bool secondIsABox, bool floodDisabled)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var (club, app, http, host) = await RigAsync($"r17fl{(secondIsABox ? "b" : "g")}");
        await using var _h = host;
        await using var _ = app;
        if (floodDisabled)
        {
            await club.WriteAsync(app, async db =>
            {
                (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == club.BoxMac)).Enabled = false;
            });
        }
        var otherMac = secondIsABox ? await AddBoxAsync(club, app) : club.DoorMac;

        var flood = new List<HttpStatusCode>();
        for (var i = 0; i < Flood; i++)
        {
            var req = floodDisabled ? club.Events(club.BoxMac, 1, "boot", 0, "") : club.Heartbeat(club.BoxMac, m1: true);
            flood.Add((await http.SendAsync(req)).StatusCode);
        }

        Assert.Contains(HttpStatusCode.TooManyRequests, flood);
        var capped = await http.SendAsync(club.Heartbeat(club.BoxMac, m1: true));
        Assert.Equal(HttpStatusCode.TooManyRequests, capped.StatusCode);
        Assert.NotNull(capped.Headers.RetryAfter);
        var other = await http.SendAsync(club.Heartbeat(otherMac, m1: true, kind: secondIsABox ? null : "gate"));
        Assert.Equal(HttpStatusCode.OK, other.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, await AnonymousLoginAsync(club, app));
    }

    /// <summary>
    /// Varied: the key spread over invented MACs (a stolen key) is still bounded per address — the device
    /// traffic from one address has a ceiling — and that ceiling is the devices' own, so the anonymous
    /// sign-in from the same address is still answered.
    /// </summary>
    [SkippableFact]
    public async Task Invented_macs_are_still_bounded_per_address_without_spending_the_anonymous_bucket()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var (club, app, http, host) = await RigAsync("r17flmac");
        await using var _h = host;
        await using var _ = app;

        var spread = new List<HttpStatusCode>();
        for (var i = 0; i < AddressBudget * 2; i++)
        {
            var mac = Guid.NewGuid().ToString("N")[..12];
            spread.Add((await http.SendAsync(club.Events(mac, 1, "boot", 0, ""))).StatusCode);
        }

        Assert.All(spread.Take(AddressBudget), s => Assert.NotEqual(HttpStatusCode.TooManyRequests, s));
        Assert.All(spread.Skip(AddressBudget), s => Assert.Equal(HttpStatusCode.TooManyRequests, s));
        Assert.Equal(HttpStatusCode.Unauthorized, await AnonymousLoginAsync(club, app));
    }

    /// <summary>
    /// Guard: a caller WITHOUT the club key at the device surface is anonymous traffic — it still spends
    /// the address bucket, so after an unauthenticated flood the address's next anonymous call is 429.
    /// </summary>
    [SkippableFact]
    public async Task A_device_flood_without_the_key_still_spends_the_address_bucket()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var (club, app, http, host) = await RigAsync("r17flnokey");
        await using var _h = host;
        await using var _ = app;

        for (var i = 0; i < AddressBudget; i++)
        {
            var req = club.Heartbeat(club.BoxMac, m1: true);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "not-the-club-key");
            Assert.NotEqual(HttpStatusCode.OK, (await http.SendAsync(req)).StatusCode);
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, await AnonymousLoginAsync(club, app));
    }
}

/// <summary>
/// Review round 17, lane BE17a, D17-3: a clamped time the calendar cannot hold says so in words. The
/// saturated claim (R16's <see cref="DeviceTime"/>) was written as <c>claimed 9999-12-31T23:59:59.9999999+00:00</c>,
/// which the faults page showed as "claimed Sat 1 Jan, 01:59".
/// </summary>
public sealed class R17ClampedClockDetailTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [Fact]
    public void A_saturated_claim_is_worded_and_an_ordinary_one_keeps_its_instant()
    {
        Assert.Equal("claimed a time beyond what can be stored", DeviceTime.ClaimedDetail(DateTimeOffset.MaxValue));
        Assert.Equal("claimed a time too long ago to be stored", DeviceTime.ClaimedDetail(DateTimeOffset.MinValue));
        var at = new DateTimeOffset(2026, 10, 6, 8, 30, 0, TimeSpan.Zero);
        Assert.Equal("claimed 2026-10-06T08:30:00.0000000+00:00", DeviceTime.ClaimedDetail(at));
    }

    /// <summary>The detail on the club's <c>clock_clamped</c> row: 2^53 ms ahead saturates; ten minutes ahead keeps its instant.</summary>
    [SkippableTheory]
    [InlineData(-9_007_199_254_740_992L, true)]
    [InlineData(-600_000L, false)]
    public async Task The_clock_clamped_row_words_a_saturated_claim(long agoMs, bool saturated)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService());
        await using var _ = app;
        var club = await MemberCodeClub.SeedAsync(app, $"r17cc{(saturated ? "s" : "o")}", MemberCodeClub.SettingsAtNoon());
        var http = app.CreateClient();

        (await http.SendAsync(club.Events(club.BoxMac, 1, "boot", -1, "", agoMs: agoMs))).EnsureSuccessStatusCode();

        var detail = await ClampDetailAsync(club, app);
        if (saturated)
        {
            Assert.Equal(DeviceTime.BeyondStorableDetail, detail);
        }
        else
        {
            Assert.NotNull(detail);
            Assert.StartsWith("claimed ", detail, StringComparison.Ordinal);
            var claimed = DateTimeOffset.Parse(detail["claimed ".Length..], System.Globalization.CultureInfo.InvariantCulture);
            Assert.InRange(claimed - DateTimeOffset.UtcNow, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(11));
        }
    }

    private static async Task<string?> ClampDetailAsync(MemberCodeClub club, WebApplicationFactory<Program> app)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            var row = await club.ReadAsync(app, db => db.DeviceErrors.IgnoreQueryFilters().AsNoTracking()
                .Where(e => e.TenantId == club.TenantId && e.Code == DeviceErrorCodes.ClockClamped).FirstOrDefaultAsync());
            if (row is not null) return row.Detail;
            Assert.True(DateTime.UtcNow < deadline, "no clock_clamped row was filed");
            await Task.Delay(100);
        }
    }
}
