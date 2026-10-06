using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 19, lane BE19c — attendance and the no-show sweep's order, over HTTP against Postgres.
/// <list type="bullet">
/// <item>E19-3: a pay-for payer with no accepted seat is not a player, so their scan — which lit the
/// court and stamped <c>bookings.CheckedInAt</c> (the money rule) — is nobody's attendance. The
/// organiser of a seatless game was credited a session at the payer's instant, the booking page's
/// organiser row printed the payer's time, and an accepted partner who never came counted too.</item>
/// <item>E19-5: the sweep's <c>booking.no_show</c> (the cause) is on the Night before the refund and
/// penalty it caused, as a cancellation's has been since R15.</item>
/// </list>
/// </summary>
public sealed class R19AttendanceHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Nonce = "5a7c9e1b3d5f7a9c";

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private async Task<Rig> RigAsync(string prefix)
    {
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService());
        return new Rig(await MemberCodeClub.SeedAsync(app, prefix), app);
    }

    private static async Task<JsonElement> SendOkAsync(Rig r, HttpRequestMessage request)
    {
        var response = await r.App.CreateClient().SendAsync(request);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return await MemberCodeClub.JsonAsync(response);
    }

    /// <summary>Pam pays for court 2 at the box, which lights it (she holds no seat unless the test gave her one).</summary>
    private static async Task PayForAsync(Rig r)
    {
        var payer = r.Club.Code(r.Club.Pam);
        await SendOkAsync(r, r.Club.PayFor(payer, 2, Nonce, confirm: false));
        var paid = await SendOkAsync(r, r.Club.PayFor(payer, 2, Nonce, confirm: true, label: "60"));
        Assert.True(paid.GetProperty("granted_seconds").GetInt32() > 0, "the pay-for should have lit the court");
    }

    private static async Task ScanAsync(Rig r, Guid member)
    {
        Assert.True((await SendOkAsync(r, r.Club.Activate(r.Club.Code(member)))).GetProperty("activated").GetBoolean());
    }

    /// <summary>Accepted seats, seat 1 first, no shares (a pay-for refuses a split game).</summary>
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

    private static async Task<int> SessionsAsync(Rig r, Guid member)
    {
        var play = await r.Club.Member(r.App, member).GetFromJsonAsync<JsonElement>("/api/v1/me/play");
        return play.GetProperty("stats").GetProperty("sessions_attended").GetInt32();
    }

    private static async Task<JsonElement> DetailAsync(Rig r, Guid bookingId) =>
        await r.Club.Member(r.App, r.Club.Olga).GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{bookingId}");

    private static JsonElement OrganiserRow(JsonElement detail) =>
        detail.GetProperty("players").EnumerateArray().Single(p => p.GetProperty("seat").GetInt32() == 1);

    private static int CheckedIn(JsonElement detail) =>
        detail.GetProperty("attendance").GetProperty("players_checked_in").GetInt32();

    private static Task<Booking> BookingAsync(Rig r, Guid id) =>
        r.Club.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == id));

    // ---- E19-3: a seatless game ------------------------------------------------------------------------

    [SkippableFact]
    public async Task A_seatless_game_only_a_payer_scanned_is_nobodys_session_and_the_organiser_row_is_not_checked_in()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r19c1");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);

        await PayForAsync(r);
        Assert.NotNull((await BookingAsync(r, booking.Id)).CheckedInAt);   // the money rule: the payer lit it

        Assert.Equal(0, await SessionsAsync(r, c.Olga));
        Assert.Equal(0, await SessionsAsync(r, c.Pam));
        var detail = await DetailAsync(r, booking.Id);
        Assert.Equal(0, CheckedIn(detail));
        Assert.Equal(JsonValueKind.Null, OrganiserRow(detail).GetProperty("checked_in_at").ValueKind);
    }

    [SkippableFact]
    public async Task The_organisers_own_scan_after_a_payer_is_their_session_and_the_row_prints_their_own_time()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r19c2");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);

        await PayForAsync(r);
        await Task.Delay(50);   // two distinct instants, so the row can only be right by reading the right one
        await ScanAsync(r, c.Olga);

        var lit = (await BookingAsync(r, booking.Id)).CheckedInAt!.Value;
        var own = (await r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(a => a.TenantId == c.TenantId && a.Action == SeatCheckIn.Action && a.ActorUserId == c.Olga))).ScanAt;
        Assert.NotEqual(lit, own);

        Assert.Equal(1, await SessionsAsync(r, c.Olga));
        Assert.Equal(0, await SessionsAsync(r, c.Pam));
        var detail = await DetailAsync(r, booking.Id);
        Assert.Equal(1, CheckedIn(detail));
        Assert.Equal(own, OrganiserRow(detail).GetProperty("checked_in_at").GetDateTimeOffset());
    }

    [SkippableFact]
    public async Task A_seatless_game_the_organiser_lit_is_still_their_session_at_the_lighting()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r19c3");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);

        await ScanAsync(r, c.Olga);

        Assert.Equal(1, await SessionsAsync(r, c.Olga));
        var detail = await DetailAsync(r, booking.Id);
        Assert.Equal(1, CheckedIn(detail));
        Assert.Equal((await BookingAsync(r, booking.Id)).CheckedInAt, OrganiserRow(detail).GetProperty("checked_in_at").GetDateTimeOffset());
    }

    // ---- E19-3: a game with seats ----------------------------------------------------------------------

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task An_accepted_partner_who_never_scanned_is_not_credited_with_a_payers_scan(bool organiserSeated)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync(organiserSeated ? "r19c4b" : "r19c4a");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);
        await SeatAsync(r, booking.Id, c.Olga, c.Sid);

        await PayForAsync(r);

        Assert.Equal(0, await SessionsAsync(r, c.Sid));
        Assert.Equal(0, await SessionsAsync(r, c.Olga));
        Assert.Equal(0, CheckedIn(await DetailAsync(r, booking.Id)));
        // "Played with" reads the same rule: nobody played, so Sid is not Olga's recent partner.
        var recent = await c.Member(r.App, c.Olga).GetFromJsonAsync<JsonElement>("/api/v1/me/partners/recent");
        Assert.DoesNotContain(recent.GetProperty("items").EnumerateArray(), i => i.GetProperty("user_id").GetGuid() == c.Sid);

        if (!organiserSeated) return;
        // A player's own scan is evidence the game happened: the partner who walked in behind the
        // organiser played (play.md §1 rule 2, the founder's default) — from the organiser's scan.
        await ScanAsync(r, c.Olga);
        Assert.Equal(1, await SessionsAsync(r, c.Olga));
        Assert.Equal(1, await SessionsAsync(r, c.Sid));
        Assert.Equal(1, CheckedIn(await DetailAsync(r, booking.Id)));
        recent = await c.Member(r.App, c.Olga).GetFromJsonAsync<JsonElement>("/api/v1/me/partners/recent");
        Assert.Contains(recent.GetProperty("items").EnumerateArray(), i => i.GetProperty("user_id").GetGuid() == c.Sid);
    }

    [SkippableFact]
    public async Task A_payer_holding_a_seat_is_a_player_so_their_scan_is_the_games_evidence()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r19c5");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);
        await SeatAsync(r, booking.Id, c.Olga, c.Sid, c.Pam);

        await PayForAsync(r);

        Assert.Equal(1, await SessionsAsync(r, c.Pam));
        Assert.Equal(1, await SessionsAsync(r, c.Sid));
        Assert.Equal(1, await SessionsAsync(r, c.Olga));
        Assert.Equal(1, CheckedIn(await DetailAsync(r, booking.Id)));
    }

    // ---- E19-5: the sweep's cause before its money -------------------------------------------------

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task The_sweeps_no_show_row_is_on_the_Night_before_the_money_it_moved(bool partner)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, partner ? "r19cns2" : "r19cns1");
        await club.CreditAsync(app, club.Organiser, 64);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddMinutes(-10).Storable());
        if (partner)
        {
            await club.CreditAsync(app, club.Sam, 50);
            (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
                new { players = new object[] { new { userId = club.Sam } } })).EnsureSuccessStatusCode();
            var seat = (await club.SeatsAsync(app, bookingId)).Single(s => s.Seat == 2);
            (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }

        await new NoShowWorker(app.Services, app.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);

        var body = await club.Client(app, club.Admin, admin: true).GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.Organiser}/trace");
        var kinds = body.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("kind").GetString()!).ToList();
        var cause = kinds.IndexOf(TraceKinds.BookingNoShow);
        Assert.True(cause >= 0, string.Join(", ", kinds));
        var refund = kinds.LastIndexOf(TraceKinds.WalletRefunded);
        var penalty = kinds.LastIndexOf(TraceKinds.WalletPenalised);
        Assert.True(refund >= 0 && penalty >= 0, string.Join(", ", kinds));
        Assert.True(cause < refund && cause < penalty, $"the money came before its cause: {string.Join(", ", kinds)}");
    }
}
