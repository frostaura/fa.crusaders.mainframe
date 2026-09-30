using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Perf round (2026-09-30), backend item 1: booking, players and play writes had shared the
/// <c>auth</c> policy's ten a minute with password and code guessing, so the eleventh booking-ish
/// call a member made in a minute — book, invite, accept, cancel — was a 429, and every
/// cancellation QUOTE spent the budget of the cancel it quoted. Writes now have their own
/// per-member token bucket (<c>RateLimits:WritesBurst</c> at once, refilled at
/// <c>RateLimits:WritesPerMinute</c>), the quote answers under the global backstop only, and the
/// guessing routes keep their ten.
/// </summary>
public sealed class WritesRateLimitHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>A booking that does not exist: the handler answers 404 after the limiter has decided.</summary>
    private static readonly Guid Nowhere = Guid.Parse("00000000-0000-0000-0000-00000000beef");

    private static string CancelPath => $"/api/v1/bookings/{Nowhere}/cancel";

    private static string QuotePath => $"/api/v1/bookings/{Nowhere}/cancellation-quote";

    /// <summary>
    /// At the PRODUCTION ceilings (auth 10, writes 60 / burst 20): fifteen writes in a row and
    /// fifteen quotes are all answered. Before the split the eleventh write was a 429.
    /// </summary>
    [SkippableFact]
    public async Task Fifteen_booking_writes_in_a_minute_are_not_refused_at_the_production_ceilings()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 10, ["WritesPerMinute"] = 60, ["WritesBurst"] = 20 },
        };
        var club = await PlayersClub.SeedAsync(f, "wrlprod");
        var olive = club.Client(f, club.Organiser);

        var writes = new List<HttpStatusCode>();
        for (var i = 0; i < 15; i++) writes.Add((await olive.PostAsync(CancelPath, content: null)).StatusCode);
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, writes);

        var quotes = new List<HttpStatusCode>();
        for (var i = 0; i < 15; i++) quotes.Add((await olive.GetAsync(QuotePath)).StatusCode);
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, quotes);
    }

    /// <summary>
    /// The writes bucket still bounds a flood, per member, and is a separate bucket from the
    /// guessing one: spending it does not close the member's QR, and the guessing ceiling
    /// is not raised by it either.
    /// </summary>
    [SkippableFact]
    public async Task The_writes_bucket_refuses_past_its_burst_per_member_and_apart_from_auth()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1, ["WritesPerMinute"] = 1, ["WritesBurst"] = 3 },
        };
        var club = await PlayersClub.SeedAsync(f, "wrlburst");
        var olive = club.Client(f, club.Organiser);

        var writes = new List<HttpStatusCode>();
        for (var i = 0; i < 4; i++) writes.Add((await olive.PostAsync(CancelPath, content: null)).StatusCode);
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, writes.Take(3));
        Assert.Equal(HttpStatusCode.TooManyRequests, writes[3]);

        // A player-list write is in the same bucket as the booking it sits beside.
        var invite = await olive.PostAsync($"/api/v1/bookings/{Nowhere}/players/{Nowhere}/nudge", content: null);
        Assert.Equal(HttpStatusCode.TooManyRequests, invite.StatusCode);

        // Quotes are reads: never in the bucket.
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await olive.GetAsync(QuotePath)).StatusCode);

        // The guessing bucket is its own: one allowed, then refused — the writes spend neither.
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await olive.PostAsync("/api/v1/me/qr/generate", content: null)).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await olive.PostAsync("/api/v1/me/qr/generate", content: null)).StatusCode);

        // Another member at the same address has a whole bucket.
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await club.Client(f, club.Sam).PostAsync(CancelPath, content: null)).StatusCode);
    }

    /// <summary>
    /// Review round 4: a test host that lowers ONLY the guessing ceiling (to test sign-in) does
    /// not inherit the production writes bucket. The factory lists WritesPerMinute and
    /// WritesBurst with the other ceilings; unlisted, a 21st write inside a second was a 429 the
    /// test was not about.
    /// </summary>
    [SkippableFact]
    public async Task A_host_that_lowers_only_auth_leaves_writes_unbounded()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1 },
        };
        var club = await PlayersClub.SeedAsync(f, "wrlfloor");
        var olive = club.Client(f, club.Organiser);

        var writes = new List<HttpStatusCode>();
        for (var i = 0; i < 25; i++) writes.Add((await olive.PostAsync(CancelPath, content: null)).StatusCode);
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, writes);
    }
}
