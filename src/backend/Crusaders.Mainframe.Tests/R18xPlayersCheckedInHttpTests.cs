using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 18, lane FX18 — the booking page's "N of M checked in" follows BE18b's E18-6 rule: a
/// pay-for payer with no accepted seat is not a player, and their scan is not the organiser's arrival.
/// A seatless game read "1 of 1 checked in" after only the payer had scanned, because the count fell
/// back to the booking's <c>CheckedInAt</c> — which is whoever lit the court (the money rule).
/// </summary>
public sealed class R18xPlayersCheckedInHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Nonce = "3c5e7a9b1d2f4a6c";

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private async Task<Rig> RigAsync(string prefix)
    {
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService());
        return new Rig(await MemberCodeClub.SeedAsync(app, prefix), app);
    }

    private static async Task<JsonElement> OkJsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return await MemberCodeClub.JsonAsync(response);
    }

    private static async Task<JsonElement> SendOkAsync(Rig r, HttpRequestMessage request) =>
        await OkJsonAsync(await r.App.CreateClient().SendAsync(request));

    private static async Task<int> CheckedInAsync(Rig r, Guid viewer, Guid bookingId, string role = "member")
    {
        var body = await r.Club.Member(r.App, viewer, role).GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{bookingId}");
        return body.GetProperty("attendance").GetProperty("players_checked_in").GetInt32();
    }

    private static async Task PayForAsync(Rig r)
    {
        var payer = r.Club.Code(r.Club.Pam);
        await SendOkAsync(r, r.Club.PayFor(payer, 2, Nonce, confirm: false));
        var paid = await SendOkAsync(r, r.Club.PayFor(payer, 2, Nonce, confirm: true, label: "60"));
        Assert.True(paid.GetProperty("granted_seconds").GetInt32() > 0, "the pay-for should have lit the court");
    }

    private static Task SeatAsync(Rig r, Guid bookingId, params Guid[] players)
    {
        return r.Club.WriteAsync(r.App, db =>
        {
            var now = DateTimeOffset.UtcNow;
            for (var i = 0; i < players.Length; i++)
            {
                db.BookingParticipants.Add(new BookingParticipant
                {
                    TenantId = r.Club.TenantId,
                    BookingId = bookingId,
                    Seat = i + 1,
                    UserId = players[i],
                    Status = ParticipantStatus.Accepted,
                    ShareWeight = 1,
                    SplitMode = i == 0 ? SplitModes.Equal : null,
                    InvitedAt = now,
                    CreatedAt = now,
                    UpdatedAt = now,
                    RespondedAt = now,
                });
            }
            return Task.CompletedTask;
        });
    }

    [SkippableFact]
    public async Task A_seatless_game_only_a_payer_scanned_has_nobody_checked_in_until_the_organiser_scans()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18xpc1");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);

        await PayForAsync(r);
        var lit = await c.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == booking.Id));
        Assert.NotNull(lit.CheckedInAt);      // the money rule: the payer lit it
        Assert.Equal(c.Pam, lit.PaidByUserId);
        Assert.Equal(0, await CheckedInAsync(r, c.Olga, booking.Id));
        Assert.Equal(0, await CheckedInAsync(r, c.AdminId, booking.Id, "admin"));

        await SendOkAsync(r, c.Activate(c.Code(c.Olga)));
        Assert.Equal(1, await CheckedInAsync(r, c.Olga, booking.Id));
    }

    [SkippableFact]
    public async Task A_seatless_game_the_organiser_lit_counts_them()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18xpc2");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);
        Assert.Equal(0, await CheckedInAsync(r, c.Olga, booking.Id));

        await SendOkAsync(r, c.Activate(c.Code(c.Olga)));
        Assert.Equal(1, await CheckedInAsync(r, c.Olga, booking.Id));
    }

    [SkippableFact]
    public async Task A_payer_holding_a_seat_counts_their_own_seat_and_never_the_organisers()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18xpc3");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);
        await SeatAsync(r, booking.Id, c.Olga, c.Pam);

        await PayForAsync(r);
        Assert.Equal(1, await CheckedInAsync(r, c.Olga, booking.Id));

        await SendOkAsync(r, c.Activate(c.Code(c.Olga)));
        Assert.Equal(2, await CheckedInAsync(r, c.Olga, booking.Id));
    }
}
