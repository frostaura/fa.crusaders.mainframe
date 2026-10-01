using System.Collections.Concurrent;
using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Perf round (2026-09-30), backend item 5 and the backend half of frontend item 4 — every change
/// here is ADDITIVE: a caller that sends none of the new parameters gets byte-for-byte the shape
/// it got before. <c>cursor</c> pages the admin members list and the admin ledger;
/// <c>photos=url</c> hands a data-URI photo out as a link; <c>include=share_bookings</c> puts the
/// summary of every share row's booking on <c>/wallet</c>, in place of one detail read per booking.
/// </summary>
public sealed class PerfReadsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private const string SvgPhoto = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnLz4=";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [SkippableFact]
    public async Task The_admin_ledger_pages_by_cursor_and_is_the_same_array_without_one()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "perfledger");
        for (var i = 1; i <= 7; i++) await club.CreditAsync(f, club.Organiser, i);
        var admin = club.Client(f, club.Admin, admin: true);

        var whole = await JsonAsync(await admin.GetAsync("/api/v1/admin/ledger/"));
        Assert.Equal(JsonValueKind.Array, whole.ValueKind);
        var all = whole.EnumerateArray().Select(r => r.GetProperty("id").GetGuid()).ToList();
        Assert.Equal(7, all.Count);

        var paged = new List<Guid>();
        var cursor = "";
        var pages = 0;
        do
        {
            var page = await JsonAsync(await admin.GetAsync($"/api/v1/admin/ledger/?limit=3&cursor={Uri.EscapeDataString(cursor)}"));
            paged.AddRange(page.GetProperty("items").EnumerateArray().Select(r => r.GetProperty("id").GetGuid()));
            cursor = page.GetProperty("next_cursor").GetString() ?? "";
            pages++;
        }
        while (cursor.Length > 0 && pages < 10);

        Assert.Equal(3, pages);
        Assert.Equal(all.Order(), paged.Order());
        Assert.Equal(paged.Count, paged.Distinct().Count());

        var bad = await admin.GetAsync("/api/v1/admin/ledger/?cursor=not-a-cursor");
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
    }

    [SkippableFact]
    public async Task The_admin_members_list_pages_by_cursor_with_a_total_and_is_the_same_array_without_one()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "perfmembers");
        var admin = club.Client(f, club.Admin, admin: true);

        var whole = await JsonAsync(await admin.GetAsync("/api/v1/admin/members/"));
        Assert.Equal(JsonValueKind.Array, whole.ValueKind);
        var all = whole.EnumerateArray().Select(r => r.GetProperty("membership_id").GetGuid()).ToList();
        Assert.Equal(6, all.Count);
        // The fields the console reads are all still there.
        foreach (var key in new[] { "user_id", "email", "full_name", "photo_url", "status", "groups", "is_admin", "balance_credits" })
        {
            Assert.True(whole[0].TryGetProperty(key, out _), key);
        }

        var first = await JsonAsync(await admin.GetAsync("/api/v1/admin/members/?limit=4&cursor="));
        Assert.Equal(6, first.GetProperty("total").GetInt32());
        var second = await JsonAsync(await admin.GetAsync(
            $"/api/v1/admin/members/?limit=4&cursor={Uri.EscapeDataString(first.GetProperty("next_cursor").GetString()!)}"));
        Assert.Equal(JsonValueKind.Null, second.GetProperty("next_cursor").ValueKind);

        var paged = first.GetProperty("items").EnumerateArray().Concat(second.GetProperty("items").EnumerateArray())
            .Select(r => r.GetProperty("membership_id").GetGuid()).ToList();
        Assert.Equal(all, paged);

        var active = await JsonAsync(await admin.GetAsync("/api/v1/admin/members/?status=Active&limit=2&cursor="));
        Assert.Equal(6, active.GetProperty("total").GetInt32());
        Assert.Equal(2, active.GetProperty("items").GetArrayLength());
    }

    [SkippableFact]
    public async Task A_data_photo_is_handed_out_as_a_cached_link_only_when_asked()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "perfphoto");
        await club.WriteAsync(f, db =>
            db.Memberships.IgnoreQueryFilters().Single(m => m.UserId == club.Organiser).PhotoUrl = SvgPhoto);
        var at = PlayersClub.Tomorrow(10);
        await club.InsertBookingAsync(f, at);
        var sam = club.Client(f, club.Sam);
        var date = at.UtcDateTime.ToString("yyyy-MM-dd");

        string? OwnerPhoto(JsonElement day) => day.GetProperty("slots").EnumerateArray()
            .Single(s => s.GetProperty("ownerUserId").GetString() == club.Organiser.ToString()).GetProperty("ownerPhotoUrl").GetString();

        Assert.Equal(SvgPhoto, OwnerPhoto(await JsonAsync(await sam.GetAsync($"/api/v1/schedule?date={date}"))));
        var link = OwnerPhoto(await JsonAsync(await sam.GetAsync($"/api/v1/schedule?date={date}&photos=url")))!;
        Assert.StartsWith("/api/v1/photos/", link, StringComparison.Ordinal);

        var members = await JsonAsync(await club.Client(f, club.Admin, admin: true).GetAsync("/api/v1/admin/members/?photos=url"));
        Assert.Equal(link, members.EnumerateArray()
            .Single(m => m.GetProperty("user_id").GetGuid() == club.Organiser).GetProperty("photo_url").GetString());

        // An <img> sends no token: the link answers anonymously, as the stored image, for good.
        var anonymous = f.CreateClient();
        var image = await anonymous.GetAsync(link);
        Assert.Equal(HttpStatusCode.OK, image.StatusCode);
        Assert.Equal("image/svg+xml", image.Content.Headers.ContentType!.MediaType);
        Assert.Equal("<svg xmlns='http://www.w3.org/2000/svg'/>", Encoding.UTF8.GetString(await image.Content.ReadAsByteArrayAsync()));
        Assert.Contains("immutable", image.Headers.CacheControl!.ToString(), StringComparison.Ordinal);
        Assert.Contains("sandbox", string.Join(";", image.Headers.GetValues("Content-Security-Policy")), StringComparison.Ordinal);

        // The hash is the check: a guessed or stale one is nothing.
        Assert.Equal(HttpStatusCode.NotFound, (await anonymous.GetAsync(link[..^1] + (link[^1] == '0' ? '1' : '0'))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anonymous.GetAsync($"/api/v1/photos/{club.Sam:N}/{link[^16..]}")).StatusCode);
    }

    [SkippableFact]
    public async Task The_wallet_carries_its_share_bookings_when_asked_and_they_match_the_detail()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "perfwallet");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 2)}/accept", new { expectedShareCredits = 16m });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());
        var olive = club.Client(f, club.Organiser);

        var plain = await JsonAsync(await olive.GetAsync("/api/v1/wallet"));
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("share_bookings").ValueKind);

        var wallet = await JsonAsync(await olive.GetAsync("/api/v1/wallet?include=share_bookings"));
        var summary = wallet.GetProperty("share_bookings").GetProperty(bookingId.ToString());
        var detail = await JsonAsync(await olive.GetAsync($"/api/v1/bookings/{bookingId}"));

        Assert.Equal(detail.GetProperty("court_name").GetString(), summary.GetProperty("court_name").GetString());
        Assert.Equal(detail.GetProperty("starts_at").GetDateTimeOffset(), summary.GetProperty("starts_at").GetDateTimeOffset());
        Assert.Equal(detail.GetProperty("organiser").GetProperty("user_id").GetGuid(), summary.GetProperty("organiser").GetProperty("user_id").GetGuid());
        Assert.Equal(detail.GetProperty("organiser").GetProperty("name").GetString(), summary.GetProperty("organiser").GetProperty("name").GetString());
        // The frontend's own summary of the detail: members other than the organiser, with what they paid.
        var expected = detail.GetProperty("players").EnumerateArray()
            .Where(p => p.GetProperty("kind").GetString() == "member" && p.GetProperty("user_id").GetGuid() != club.Organiser)
            .Select(p => (p.GetProperty("user_id").GetGuid(), p.GetProperty("name").GetString(), p.GetProperty("paid_credits").GetDecimal()))
            .ToList();
        var actual = summary.GetProperty("partners").EnumerateArray()
            .Select(p => (p.GetProperty("user_id").GetGuid(), p.GetProperty("name").GetString(), p.GetProperty("paid_credits").GetDecimal()))
            .ToList();
        Assert.Equal(expected, actual);
        Assert.Equal([(club.Sam, "Sam Partner", 16m)], actual);

        // Somebody the booking is nothing to reads null, as the detail's 404.
        var stranger = await club.InClubAsync(f, sp => sp.GetRequiredService<PlayersQuery>()
            .ShareSummariesAsync([bookingId], club.Bystander, viewerIsAdmin: false, CancellationToken.None));
        Assert.Null(stranger[bookingId]);
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Bystander).GetAsync($"/api/v1/bookings/{bookingId}")).StatusCode);
    }

    /// <summary>Every command the app sends while recording is on.</summary>
    private sealed class RecordingInterceptor : DbCommandInterceptor
    {
        public ConcurrentQueue<string> Commands { get; } = new();

        public volatile bool On;

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            if (On) Commands.Enqueue(command.CommandText);
            return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
        }
    }

    /// <summary>
    /// Review round 5, P5-5: the wallet's share summaries read every partner's paid figure in ONE
    /// query, whatever the number of seats. It awaited one sum per seat — two bookings of three
    /// partners each was six reads, a page of twenty bookings 37 connection opens.
    /// </summary>
    [SkippableFact]
    public async Task Share_summaries_read_every_seats_paid_figure_in_one_query()
    {
        Skip.IfNot(pg.Available, Skipped);
        var recorder = new RecordingInterceptor();
        await using var f = CreateFactory();
        await using var app = f.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(recorder))));
        var club = await PlayersClub.SeedAsync(app, "perfsharen1");
        await club.CreditAsync(app, club.Organiser, 200m);
        object[] three = [new { userId = club.Sam }, new { userId = club.Alex }, new { userId = club.Jo }];
        var (first, _) = await club.BookWithPlayersAsync(app, three, at: PlayersClub.Tomorrow(8));
        var (second, _) = await club.BookWithPlayersAsync(app, three, at: PlayersClub.Tomorrow(8).AddDays(1));

        recorder.On = true;
        var summaries = await club.InClubAsync(app, sp => sp.GetRequiredService<PlayersQuery>()
            .ShareSummariesAsync([first, second], club.Organiser, viewerIsAdmin: false, CancellationToken.None));
        recorder.On = false;

        Assert.NotNull(summaries[first]);
        Assert.NotNull(summaries[second]);
        var paidReads = recorder.Commands.Count(sql =>
            sql.Contains("FROM ledger_entries", StringComparison.Ordinal)
            && sql.Contains("\"ExternalReference\"", StringComparison.Ordinal));
        Assert.Equal(1, paidReads);
    }
}
