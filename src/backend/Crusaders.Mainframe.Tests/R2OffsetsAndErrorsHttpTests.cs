using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, B-9 (ADM-L): <c>POST /bookings</c> with a <c>+02:00</c> start answered 500 with an
/// Npgsql stack trace. An instant in a request body is read as UTC; query-string instants on the
/// admin ledger and spend reads are normalised; and anything unhandled is
/// <c>500 {"error":"internal_error"}</c> in every environment, never a trace.
/// </summary>
public sealed class R2OffsetsAndErrorsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    [SkippableFact]
    public async Task A_booking_sent_in_the_clubs_own_offset_is_booked_at_that_instant()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var club = await PlayersClub.SeedAsync(f, "r2offset");
        await club.CreditAsync(f, club.Organiser, 100m);
        var utc = PlayersClub.Tomorrow(8);
        var sast = utc.ToOffset(TimeSpan.FromHours(2)).ToString("yyyy-MM-dd'T'HH:mm:sszzz");

        using var body = new StringContent(
            $$"""{"courtId":"{{club.CourtId}}","startsAt":"{{sast}}","sliceCount":2}""", System.Text.Encoding.UTF8, "application/json");
        var response = await club.Client(f, club.Organiser).PostAsync("/api/v1/bookings", body);

        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("booking_id").GetGuid();
        var stored = await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == id).Select(b => b.StartsAt).FirstAsync());
        Assert.Equal(utc, stored);
    }

    [SkippableFact]
    public async Task The_admin_ledger_and_spend_reads_take_an_offset_range()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var club = await PlayersClub.SeedAsync(f, "r2offq");
        var admin = club.Client(f, club.Admin, admin: true);
        var from = Uri.EscapeDataString(DateTimeOffset.UtcNow.AddDays(-2).ToOffset(TimeSpan.FromHours(2)).ToString("yyyy-MM-dd'T'HH:mm:sszzz"));
        var to = Uri.EscapeDataString(DateTimeOffset.UtcNow.AddDays(1).ToOffset(TimeSpan.FromHours(2)).ToString("yyyy-MM-dd'T'HH:mm:sszzz"));

        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync($"/api/v1/admin/ledger?from={from}&to={to}")).StatusCode);
        var membership = await PlayersClub.ReadAsync(f, db => db.Memberships.IgnoreQueryFilters().Where(m => m.UserId == club.Sam).Select(m => m.Id).FirstAsync());
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync($"/api/v1/admin/members/{membership}/spend?from={from}&to={to}")).StatusCode);
    }

    [SkippableFact]
    public async Task A_malformed_instant_is_still_a_400()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var club = await PlayersClub.SeedAsync(f, "r2offbad");
        using var body = new StringContent(
            $$"""{"courtId":"{{club.CourtId}}","startsAt":"tomorrow at ten","sliceCount":2}""", System.Text.Encoding.UTF8, "application/json");
        Assert.Equal(HttpStatusCode.BadRequest, (await club.Client(f, club.Organiser).PostAsync("/api/v1/bookings", body)).StatusCode);
    }

    private sealed class ThrowingIssuer : IJwtIssuer
    {
        public string IssueAccess(Guid userId, Guid tenantId, string tenantSlug, IEnumerable<string> roles, int sessionEpoch) =>
            throw new InvalidOperationException("boom — a secret detail that must not leave the process");
        public string IssueOneTime(Guid userId, Guid tenantId, string tenantSlug, TicketScope scope, int sessionEpoch) => throw new NotSupportedException();
        public string IssueOneTime(Guid userId, Guid tenantId, string tenantSlug, TicketScope scope, IEnumerable<string> roles, int sessionEpoch) =>
            throw new NotSupportedException();
        public string BindToFamily(string accessToken, Guid familyId) => throw new NotSupportedException();
    }

    [SkippableTheory]
    [InlineData("Development")]
    [InlineData("Testing")]
    public async Task An_unhandled_exception_is_a_stable_500_with_no_trace_in_any_environment(string environment)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var club = await PlayersClub.SeedAsync(factory, "r2err");
        var f = factory.WithWebHostBuilder(b =>
        {
            b.UseEnvironment(environment);
            b.ConfigureServices(s =>
            {
                s.RemoveAll<IJwtIssuer>();
                s.AddScoped<IJwtIssuer, ThrowingIssuer>();
            });
        });

        var response = await club.Client(f, club.Organiser).PostAsync("/api/v1/auth/refresh", null);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync();
        Assert.Equal(InternalErrors.Code, JsonDocument.Parse(text).RootElement.GetProperty("error").GetString());
        Assert.DoesNotContain("boom", text);
        Assert.DoesNotContain("   at ", text);
    }
}
