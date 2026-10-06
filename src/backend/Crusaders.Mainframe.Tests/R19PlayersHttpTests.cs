using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>Shared set-up for the R19 lane BE19j classes below.</summary>
internal static class R19Kit
{
    public static string SplitUrl(R16Kit.Game g) => $"/api/v1/bookings/{g.BookingId}/split";

    public static object AmountSplit(Guid seat, int amount) =>
        new { mode = "amount", seats = new[] { new { participantId = seat, amount = (decimal)amount } } };

    public static async Task<int> ShareAsync(R16Kit.Game g, Guid seat) => (await R18Kit.SeatAsync(g, seat)).ShareMinutes;

    public static Task<HttpResponseMessage> AcceptAsync(R16Kit.Game g, Guid user, Guid seat, int expected) =>
        g.As(user).PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: false), new { expectedShareMinutes = expected });

    public static async Task<JsonElement> BodyAsync(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
}

/// <summary>
/// Review round 19, lane BE19j, J19-1: a partner's accept that loses its save to another write on the
/// same seat — the organiser's re-split, a nudge — was answered <c>409 invite_closed</c> ("This invite has
/// closed") above an invite that was plainly still open. The lost race now re-reads the seat: still
/// open → <c>share_changed</c> with the current figure when the share moved from the one the partner was
/// shown, else <c>conflict_retry</c>; <c>invite_closed</c> only for a seat that really closed.
/// Nothing is taken from the partner in any of these.
/// </summary>
public sealed class R19AcceptRaceHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableTheory]
    [InlineData(1, 20)]
    [InlineData(1, 10)]
    [InlineData(2, 14)]
    [InlineData(2, 6)]
    public async Task An_accept_that_loses_to_a_resplit_is_share_changed_with_the_new_figure(int partners, int newShare)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r19j-sp{partners}-{newShare}", partners, accept: false);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        var shown = await R19Kit.ShareAsync(g, seat);
        HttpResponseMessage? split = null;
        rig.Twin.Arm("INSERT INTO ledger_entries", async () =>
            split = await g.As(g.Club.Organiser).PutAsJsonAsync(R19Kit.SplitUrl(g), R19Kit.AmountSplit(seat, newShare)));

        var accept = await R19Kit.AcceptAsync(g, g.Club.Sam, seat, shown);

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(split!.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(split));
        Assert.True(accept.StatusCode == HttpStatusCode.Conflict, await R18Kit.DescribeAsync(accept));
        var body = await R19Kit.BodyAsync(accept);
        Assert.Equal(PlayerErrors.ShareChanged, body.GetProperty("error").GetString());
        Assert.Equal(newShare, body.GetProperty("share_minutes").GetInt32());
        Assert.Equal(ParticipantStatus.Invited, (await R18Kit.SeatAsync(g, seat)).Status);
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));

        // Asked again at the figure now shown, the same invite is taken.
        var again = await R19Kit.AcceptAsync(g, g.Club.Sam, seat, newShare);
        Assert.True(again.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(again));
        Assert.Equal(50 - newShare, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task An_accept_that_loses_to_a_nudge_is_conflict_retry_and_the_retry_is_taken(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r19j-nd{partners}", partners, accept: false);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        var shown = await R19Kit.ShareAsync(g, seat);
        HttpResponseMessage? nudge = null;
        rig.Twin.Arm("INSERT INTO ledger_entries", async () =>
            nudge = await g.As(g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}/nudge", null));

        var accept = await R19Kit.AcceptAsync(g, g.Club.Sam, seat, shown);

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(nudge!.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(nudge));
        Assert.True(accept.StatusCode == HttpStatusCode.Conflict, await R18Kit.DescribeAsync(accept));
        Assert.Equal(PlayerErrors.Conflict, await R18Kit.ErrorAsync(accept));
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));

        var again = await R19Kit.AcceptAsync(g, g.Club.Sam, seat, shown);
        Assert.True(again.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(again));
        Assert.Equal(50 - shown, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }

    /// <summary>The control: a seat the organiser really took off while the accept decided is closed, and says so.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task An_accept_that_loses_to_a_removal_is_invite_closed(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r19j-rm{partners}", partners, accept: false);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        var shown = await R19Kit.ShareAsync(g, seat);
        var removed = false;
        // On its own connection: an HTTP removal would wait on the inbox rows the accept is marking read.
        rig.Twin.Arm("INSERT INTO ledger_entries", async () =>
        {
            await using var connection = new NpgsqlConnection(pg.ConnectionString!);
            await connection.OpenAsync();
            await using var off = new NpgsqlCommand(
                "SET lock_timeout = '1500ms'; UPDATE booking_participants SET \"Status\" = @removed, \"Version\" = \"Version\" + 1 WHERE \"Id\" = @id",
                connection);
            off.Parameters.AddWithValue("removed", (int)ParticipantStatus.Removed);
            off.Parameters.AddWithValue("id", seat);
            removed = await off.ExecuteNonQueryAsync() == 1;
        });

        var accept = await R19Kit.AcceptAsync(g, g.Club.Sam, seat, shown);

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(removed);
        Assert.Equal(PlayerErrors.InviteClosed, await R18Kit.ErrorAsync(accept));
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }

    /// <summary>A share re-split back to the very figure the partner was shown is not "changed": the retry answer is the clash.</summary>
    [SkippableFact]
    public async Task An_accept_that_loses_to_a_resplit_to_the_same_figure_is_conflict_retry()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, "r19j-spsame", 2, accept: false);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        var shown = await R19Kit.ShareAsync(g, seat);
        var alex = g.SeatOf[g.Club.Alex];
        HttpResponseMessage? split = null;
        // Alex's share moves; Sam's is written (the seat's version moves) but stays the figure Sam was shown.
        rig.Twin.Arm("INSERT INTO ledger_entries", async () =>
            split = await g.As(g.Club.Organiser).PutAsJsonAsync(R19Kit.SplitUrl(g), new
            {
                mode = "amount",
                seats = new[] { new { participantId = seat, amount = (decimal)shown }, new { participantId = alex, amount = 4m } },
            }));

        var accept = await R19Kit.AcceptAsync(g, g.Club.Sam, seat, shown);

        Assert.True(split!.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(split));
        Assert.True(accept.StatusCode == HttpStatusCode.Conflict, await R18Kit.DescribeAsync(accept));
        Assert.Equal(PlayerErrors.Conflict, await R18Kit.ErrorAsync(accept));
        Assert.Equal(shown, await R19Kit.ShareAsync(g, seat));
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }
}

/// <summary>
/// Review round 19, lane BE19j, J19-4: the cancel's answer names every partner refund the cancel caused —
/// including a share an accept took while the cancel was on its way. The figures were read before the
/// cancel decided, so an accept landing in between was refunded on the ledger and missing from the answer
/// (<c>partner_refunds: []</c>, a net that counted the partner's money as the organiser's).
/// </summary>
public sealed class R19CancelAnswerHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableTheory]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    public async Task An_accept_landing_while_the_cancel_decides_is_in_the_cancels_answer(int partners, bool byClub)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r19j-ca{partners}{(byClub ? "c" : "o")}", partners, accept: false);
        var g = rig.Game;
        var sam = g.SeatOf[g.Club.Sam];
        var samShare = await R19Kit.ShareAsync(g, sam);
        var alexShare = 0;
        if (partners == 2)
        {
            // Alex paid before the cancel was asked; Sam pays while it is on its way.
            var alex = g.SeatOf[g.Club.Alex];
            alexShare = await R19Kit.ShareAsync(g, alex);
            (await R19Kit.AcceptAsync(g, g.Club.Alex, alex, alexShare)).EnsureSuccessStatusCode();
        }
        HttpResponseMessage? accept = null;
        rig.Twin.Arm("UPDATE bookings", async () => accept = await R19Kit.AcceptAsync(g, g.Club.Sam, sam, samShare));

        var cancel = byClub
            ? await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court repairs" })
            : await g.As(g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null);

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(accept!.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(accept));
        Assert.True(cancel.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(cancel));
        var body = await R19Kit.BodyAsync(cancel);
        var refunds = body.GetProperty("partner_refunds").EnumerateArray()
            .ToDictionary(r => r.GetProperty("user_id").GetGuid(), r => r.GetProperty("minutes").GetInt32());
        Assert.Equal(samShare, refunds.GetValueOrDefault(g.Club.Sam));
        if (partners == 2) Assert.Equal(alexShare, refunds.GetValueOrDefault(g.Club.Alex));
        var net = body.GetProperty("refunded_minutes").GetInt32() - body.GetProperty("penalty_minutes").GetInt32() - samShare - alexShare;
        Assert.Equal(net, body.GetProperty("net_minutes").GetInt32());

        // The answer is the ledger's: every partner whole, the organiser exactly back where they started.
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
        if (partners == 2) Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Alex));
        Assert.Equal(100, await R18Kit.BalanceAsync(g, g.Club.Organiser));
    }
}

/// <summary>
/// Review round 19, lane BE19j, J19-5: a player added to a booking that already has four live seats is
/// refused <c>409 booking_full</c> ("This booking already has four players."), by the organiser and by the
/// desk, member or guest — never <c>seat_taken</c> ("That seat was taken a moment ago. Pick another."),
/// which sends the organiser looking for a seat that does not exist.
/// </summary>
public sealed class R19BookingFullHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableTheory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(true, true, true)]
    public async Task Adding_to_a_four_seat_booking_is_booking_full(bool byClub, bool guest, bool fourthIsGuest)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r19j-full{(byClub ? "c" : "o")}{(guest ? "g" : "m")}{(fourthIsGuest ? "g" : "m")}", 2, accept: false)).Game;
        object fourth = fourthIsGuest ? new { guestName = "Kim Guest" } : new { userId = g.Club.Jo };
        (await g.As(g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players", new { players = new[] { fourth } })).EnsureSuccessStatusCode();
        var seatsBefore = (await g.Club.SeatsAsync(g.App, g.BookingId)).Count;

        var add = byClub
            ? await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players",
                guest ? new { guestName = "Lee Guest", reason = "Walk-in" } : (object)new { userId = g.Club.Bystander, reason = "Walk-in" })
            : await g.As(g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players",
                new { players = new[] { guest ? (object)new { guestName = "Lee Guest" } : new { userId = g.Club.Bystander } } });

        Assert.True(add.StatusCode == HttpStatusCode.Conflict, await R18Kit.DescribeAsync(add));
        Assert.Equal(PlayerErrors.BookingFull, await R18Kit.ErrorAsync(add));
        Assert.Equal(seatsBefore, (await g.Club.SeatsAsync(g.App, g.BookingId)).Count);
    }

    /// <summary>One seat left and two asked for: the booking is not full, but they will not both fit.</summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Adding_more_than_the_seats_left_is_too_many_players(bool guests)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r19j-over{(guests ? "g" : "m")}", 2, accept: false)).Game;
        object[] two = guests
            ? [new { guestName = "Kim Guest" }, new { guestName = "Lee Guest" }]
            : [new { userId = g.Club.Jo }, new { userId = g.Club.Bystander }];

        var add = await g.As(g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players", new { players = two });

        Assert.True(add.StatusCode == HttpStatusCode.Conflict, await R18Kit.DescribeAsync(add));
        var body = await R19Kit.BodyAsync(add);
        Assert.Equal(PlayerErrors.TooManyPlayers, body.GetProperty("error").GetString());
        Assert.Equal(1, body.GetProperty("free_seats").GetInt32());
    }

    /// <summary>The control: a named seat someone holds, with another seat free, is still "that seat was taken".</summary>
    [SkippableFact]
    public async Task Naming_a_held_seat_with_one_free_is_still_seat_taken()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, "r19j-held", 2, accept: false)).Game;

        var add = await g.As(g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players",
            new { players = new[] { new { userId = g.Club.Jo, seat = 2 } } });

        Assert.Equal(PlayerErrors.SeatTaken, await R18Kit.ErrorAsync(add));
    }
}

/// <summary>
/// Review round 19, lane BE19j, J19-6: the organiser's identical re-split sent twice at once (a double tap,
/// a retried request) answered one 200 and <c>conflict_retry</c> to the rest. A twin that finds the seats
/// already where its request would put them is the winner's answer too — 200, the same shares, no extra
/// change record or notice — like R18's seat twins. A DIFFERENT split meeting it is still the clash.
/// </summary>
public sealed class R19SplitTwinHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Identical_parallel_resplits_all_answer_200_and_are_recorded_once(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r19j-tw{partners}", partners, accept: true)).Game;
        var seat = g.SeatOf[g.Club.Sam];
        var target = await R19Kit.ShareAsync(g, seat) - 4;

        var answers = await R18Kit.AtOnceAsync(3, () => g.As(g.Club.Organiser).PutAsJsonAsync(R19Kit.SplitUrl(g), R19Kit.AmountSplit(seat, target)));

        foreach (var a in answers) Assert.True(a.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(a));
        foreach (var a in answers)
        {
            var share = (await R19Kit.BodyAsync(a)).GetProperty("shares").EnumerateArray().Single(s => s.GetProperty("participant_id").GetGuid() == seat);
            Assert.Equal(target, share.GetProperty("share_minutes").GetInt32());
        }
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.SplitChangedAction, g.Club.Sam));
        Assert.Equal(50 - target, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_resplit_whose_identical_twin_saved_first_answers_200_and_writes_nothing(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r19j-tt{partners}", partners, accept: true);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        var target = await R19Kit.ShareAsync(g, seat) - 4;
        HttpResponseMessage? twin = null;
        rig.Twin.Arm("INSERT INTO audit_log ", async () =>
            twin = await g.As(g.Club.Organiser).PutAsJsonAsync(R19Kit.SplitUrl(g), R19Kit.AmountSplit(seat, target)));

        var ours = await g.As(g.Club.Organiser).PutAsJsonAsync(R19Kit.SplitUrl(g), R19Kit.AmountSplit(seat, target));

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(twin!.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(twin));
        Assert.True(ours.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(ours));
        Assert.Equal("amount", (await R19Kit.BodyAsync(ours)).GetProperty("split_mode").GetString());
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.SplitChangedAction, g.Club.Sam));
        Assert.Single(await R18Kit.LinesAsync(g, g.Club.Sam), n => n.DedupeKey.StartsWith("split:", StringComparison.Ordinal));
        Assert.Equal(50 - target, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_resplit_whose_different_twin_saved_first_is_still_conflict_retry(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r19j-td{partners}", partners, accept: true);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        var share = await R19Kit.ShareAsync(g, seat);
        rig.Twin.Arm("INSERT INTO audit_log ", async () =>
            (await g.As(g.Club.Organiser).PutAsJsonAsync(R19Kit.SplitUrl(g), R19Kit.AmountSplit(seat, share - 2))).EnsureSuccessStatusCode());

        var ours = await g.As(g.Club.Organiser).PutAsJsonAsync(R19Kit.SplitUrl(g), R19Kit.AmountSplit(seat, share - 4));

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(ours.StatusCode == HttpStatusCode.Conflict, await R18Kit.DescribeAsync(ours));
        Assert.Equal(PlayerErrors.Conflict, await R18Kit.ErrorAsync(ours));
        Assert.Equal(share - 2, await R19Kit.ShareAsync(g, seat));
    }
}
