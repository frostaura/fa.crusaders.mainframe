using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Results on a booking (<c>docs/specs/play.md</c> §3, §6.1) on Postgres: when a result may be
/// recorded, the lineup rules, the state machine and its refusals, the deadline as an instant, and
/// the races that must lose cleanly.
/// </summary>
public sealed class PlayResultsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    private static DateTimeOffset Earlier(int hours = 2) => DateTimeOffset.UtcNow.AddHours(-hours).Storable();

    [SkippableFact]
    public async Task A_player_records_a_checked_in_game_and_it_waits_exactly_the_clubs_hours()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-record");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);

        var response = await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.JsonAsync();
        Assert.Equal("pending", body.GetProperty("status").GetString());
        Assert.Equal("a", body.GetProperty("winner").GetString());
        Assert.Equal(3, body.GetProperty("games_won").GetProperty("a").GetInt32());
        Assert.Equal("a", body.GetProperty("viewer_side").GetString());
        Assert.Equal("won", body.GetProperty("viewer_outcome").GetString());

        var row = (await ResultRowAsync(f, booking))!;
        Assert.Equal(row.SubmittedAt.AddHours(48), row.ConfirmDueAt);
        Assert.Equal(2, row.Players.Count);

        var samView = await ReadResultAsync(club.Client(f, club.Sam), booking);
        Assert.True(samView.GetProperty("permissions").GetProperty("can_confirm").GetBoolean());
        Assert.False(samView.GetProperty("permissions").GetProperty("can_edit").GetBoolean());
        Assert.Equal("b", samView.GetProperty("result").GetProperty("viewer_side").GetString());
        Assert.Equal("UTC", samView.GetProperty("timezone").GetString());
        var olive = await ReadResultAsync(club.Client(f, club.Organiser), booking);
        Assert.True(olive.GetProperty("permissions").GetProperty("can_edit").GetBoolean());
        Assert.True(olive.GetProperty("permissions").GetProperty("can_withdraw").GetBoolean());
        Assert.False(olive.GetProperty("permissions").GetProperty("can_record").GetBoolean());
    }

    [SkippableFact]
    public async Task A_booking_is_not_recordable_without_the_box_after_the_window_or_alone()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-closed");
        var organiser = club.Client(f, club.Organiser);

        var unseen = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam], checkIn: false);
        await AssertNotRecordable(organiser, unseen, "not_checked_in");
        Assert.Equal("not_checked_in", (await ReadResultAsync(organiser, unseen)).GetProperty("not_recordable_reason").GetString());

        var old = await club.GameAsync(f, DateTimeOffset.UtcNow.AddDays(-9), club.Organiser, [club.Sam]);
        await AssertNotRecordable(organiser, old, "window_closed");

        var alone = await club.GameAsync(f, Earlier(5), club.Organiser, []);
        await AssertNotRecordable(organiser, alone, "not_enough_players");
    }

    private static async Task AssertNotRecordable(HttpClient client, Guid booking, string reason)
    {
        var response = await RecordAsync(client, booking, [U(Guid.NewGuid())], [U(Guid.NewGuid())]);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.JsonAsync();
        Assert.Equal("result_not_recordable", body.GetProperty("error").GetString());
        Assert.Equal(reason, body.GetProperty("reason").GetString());
    }

    /// <summary>S4 (cancelled after check-in) and a reversed no-show were played; a no-show was not.</summary>
    [SkippableFact]
    public async Task A_cancellation_after_check_in_and_a_reversed_no_show_are_recordable_and_a_no_show_is_not()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-states");
        var organiser = club.Client(f, club.Organiser);

        var s4 = await club.GameAsync(f, Earlier(3), club.Organiser, [club.Sam]);
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == s4);
            b.Status = BookingStatus.Cancelled;
            b.CancelledAt = b.StartsAt.AddMinutes(20);
        });
        Assert.Equal(HttpStatusCode.Created, (await RecordAsync(organiser, s4, [U(club.Organiser)], [U(club.Sam)])).StatusCode);

        var reversed = await club.GameAsync(f, Earlier(6), club.Organiser, [club.Sam], checkIn: false);
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == reversed);
            b.Status = BookingStatus.Completed;
            b.NoShowReversedAt = DateTimeOffset.UtcNow;
            b.CheckedInAt = b.StartsAt.AddMinutes(4);
        });
        Assert.Equal(HttpStatusCode.Created, (await RecordAsync(organiser, reversed, [U(club.Organiser)], [U(club.Sam)])).StatusCode);

        var noShow = await club.GameAsync(f, Earlier(9), club.Organiser, [club.Sam], checkIn: false);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(x => x.Id == noShow).Status = BookingStatus.NoShow);
        await AssertNotRecordable(organiser, noShow, "not_checked_in");
    }

    [SkippableFact]
    public async Task The_lineup_is_the_results_own_singles_or_doubles_from_the_bookings_players()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-lineup");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam, club.Alex, club.Jo]);
        var organiser = club.Client(f, club.Organiser);

        async Task Refused(string[] a, string[] b, string reason, HttpClient? as_ = null)
        {
            var response = await RecordAsync(as_ ?? organiser, booking, a, b);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.JsonAsync();
            Assert.Equal("lineup_invalid", body.GetProperty("error").GetString());
            Assert.Equal(reason, body.GetProperty("reason").GetString());
        }

        await Refused([U(club.Organiser), U(club.Sam), U(club.Alex)], [U(club.Jo)], "side_size");
        await Refused([U(club.Organiser)], [], "side_size");
        await Refused([U(club.Organiser), U(club.Sam)], [U(club.Jo)], "uneven_sides");
        await Refused([U(club.Organiser)], [U(club.Organiser)], "duplicate_player");
        await Refused([U(club.Organiser)], [U(club.Bystander)], "unknown_player");
        await Refused([U(club.Organiser)], ["x:nonsense"], "unknown_player");
        await Refused([U(club.Sam)], [U(club.Jo)], "submitter_not_in_lineup");

        // Singles on a four-seat booking — the organiser against Jo, whose seat is on team B.
        var created = await RecordAsync(organiser, booking, [U(club.Organiser)], [U(club.Jo)]);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var alexView = await ReadResultAsync(club.Client(f, club.Alex), booking);
        Assert.Equal(JsonNull, alexView.GetProperty("result").GetProperty("viewer_side").ValueKind);
        Assert.False(alexView.GetProperty("permissions").GetProperty("can_confirm").GetBoolean());
        var sides = alexView.GetProperty("default_sides");
        Assert.Equal([U(club.Organiser), U(club.Sam)], sides.GetProperty("a").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal(4, alexView.GetProperty("candidates").GetArrayLength());
    }

    private const System.Text.Json.JsonValueKind JsonNull = System.Text.Json.JsonValueKind.Null;

    [SkippableFact]
    public async Task A_guest_can_be_the_other_side_and_the_result_confirms_itself_for_the_submitter_alone()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-guest");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        var guest = await club.GuestAsync(f, booking, 3, "Gus Guest");
        var organiser = club.Client(f, club.Organiser);

        var created = await RecordAsync(organiser, booking, [U(club.Organiser)], [$"g:{guest}"]);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var body = await created.JsonAsync();
        var b = body.GetProperty("sides").GetProperty("b")[0];
        Assert.Equal("guest", b.GetProperty("kind").GetString());
        Assert.Equal("Gus Guest", b.GetProperty("name").GetString());

        // Nobody can confirm it: the deadline does.
        var row = (await ResultRowAsync(f, booking))!;
        await club.SetDueAsync(f, row.Id, DateTimeOffset.UtcNow.AddSeconds(-1));
        var read = await ReadResultAsync(organiser, booking);
        Assert.Equal("confirmed", read.GetProperty("result").GetProperty("status").GetString());
        Assert.True(read.GetProperty("result").GetProperty("auto_confirmed").GetBoolean());

        var olive = await MyGameAsync(organiser);
        Assert.Equal(1, olive.GetProperty("stats").GetProperty("matches_won").GetInt32());
        var sam = await MyGameAsync(club.Client(f, club.Sam));
        Assert.Equal(0, sam.GetProperty("stats").GetProperty("matches_played").GetInt32());
    }

    [SkippableFact]
    public async Task A_replayed_create_answers_the_row_it_made_and_a_second_record_is_result_exists()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-replay");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        var organiser = club.Client(f, club.Organiser);

        Assert.Equal(HttpStatusCode.BadRequest, (await RecordAsync(organiser, booking, [U(club.Organiser)], [U(club.Sam)], key: new string('k', 65))).StatusCode);
        var first = await RecordAsync(organiser, booking, [U(club.Organiser)], [U(club.Sam)], key: "tap-1");
        var again = await RecordAsync(organiser, booking, [U(club.Organiser)], [U(club.Sam)], key: "tap-1");
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var firstId = (await first.JsonAsync()).GetProperty("result_id").GetGuid();
        Assert.Equal(firstId, (await again.JsonAsync()).GetProperty("result_id").GetGuid());

        var other = await RecordAsync(club.Client(f, club.Sam), booking, [U(club.Sam)], [U(club.Organiser)]);
        Assert.Equal(HttpStatusCode.Conflict, other.StatusCode);
        var body = await other.JsonAsync();
        Assert.Equal("result_exists", body.GetProperty("error").GetString());
        Assert.Equal(firstId, body.GetProperty("result_id").GetGuid());
        Assert.Equal(1, await PlayersClub.ReadAsync(f, db => db.MatchResults.IgnoreQueryFilters().CountAsync(r => r.BookingId == booking)));
    }

    /// <summary>
    /// One live result per booking is the DATABASE's rule, not only the service's: a second live row
    /// is refused by the partial unique index, and two members recording at once get one result
    /// and one <c>result_exists</c>.
    /// </summary>
    [SkippableFact]
    public async Task One_live_result_per_booking_holds_under_a_race_and_in_the_database()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-onelive");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);

        var answers = await Task.WhenAll(
            RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]),
            RecordAsync(club.Client(f, club.Sam), booking, [U(club.Sam)], [U(club.Organiser)]),
            RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]));
        Assert.Single(answers, a => a.StatusCode == HttpStatusCode.Created);
        foreach (var refused in answers.Where(a => a.StatusCode != HttpStatusCode.Created))
        {
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
            Assert.Equal("result_exists", (await refused.JsonAsync()).GetProperty("error").GetString());
        }
        Assert.Equal(1, await PlayersClub.ReadAsync(f, db => db.MatchResults.IgnoreQueryFilters().CountAsync(r => r.BookingId == booking)));

        var live = (await ResultRowAsync(f, booking))!;
        var second = new MatchResult
        {
            TenantId = club.TenantId, BookingId = booking, Status = MatchResultStatus.Disputed, GamesJson = "[]", GamesWonA = 3, GamesWonB = 0,
            SubmittedByUserId = club.Sam, RecordedByUserId = club.Sam, IdempotencyKey = "direct", SubmittedAt = DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        };
        await Assert.ThrowsAsync<DbUpdateException>(() => club.WriteAsync(f, db => db.MatchResults.Add(second)));
        await club.WriteAsync(f, db => db.MatchResults.IgnoreQueryFilters().First(r => r.Id == live.Id).Status = MatchResultStatus.Voided);
        await club.WriteAsync(f, db => db.MatchResults.Add(new MatchResult
        {
            TenantId = club.TenantId, BookingId = booking, Status = MatchResultStatus.Disputed, GamesJson = "[]", GamesWonA = 3, GamesWonB = 0,
            SubmittedByUserId = club.Sam, RecordedByUserId = club.Sam, IdempotencyKey = "direct-2", SubmittedAt = DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        }));
    }

    [SkippableFact]
    public async Task Scores_are_refused_with_the_corpus_reasons()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-scores");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        var organiser = club.Client(f, club.Organiser);
        string[] a = [U(club.Organiser)], b = [U(club.Sam)];

        var bad = await (await RecordAsync(organiser, booking, a, b, G((11, 10), (11, 0), (11, 0)))).JsonAsync();
        Assert.Equal(("score_invalid", 0, "not_two_clear"), (bad.GetProperty("error").GetString(), bad.GetProperty("game_index").GetInt32(), bad.GetProperty("reason").GetString()));
        var incomplete = await (await RecordAsync(organiser, booking, a, b, G((11, 5)), format: "best_of_3")).JsonAsync();
        Assert.Equal(2, incomplete.GetProperty("games_needed").GetInt32());
        var after = await (await RecordAsync(organiser, booking, a, b, G((11, 5), (11, 5), (11, 5)), format: "best_of_3")).JsonAsync();
        Assert.Equal(("games_after_decided", 2), (after.GetProperty("error").GetString(), after.GetProperty("game_index").GetInt32()));
        Assert.Equal("format_invalid", (await (await RecordAsync(organiser, booking, a, b, format: "best_of_7")).JsonAsync()).GetProperty("error").GetString());

        var fractional = await organiser.PostAsJsonAsync($"/api/v1/bookings/{booking}/result", new
        {
            idempotencyKey = "frac", format = "best_of_3", sideA = a, sideB = b, games = new object[] { new { a = 11, b = 7 }, new { a = 11.5, b = 9 } },
        });
        var frac = await fractional.JsonAsync();
        Assert.Equal(("score_invalid", 1, "negative"), (frac.GetProperty("error").GetString(), frac.GetProperty("game_index").GetInt32(), frac.GetProperty("reason").GetString()));
        Assert.Null(await ResultRowAsync(f, booking));
    }

    [SkippableFact]
    public async Task An_edit_by_the_submitting_side_replaces_the_score_and_restarts_the_clock()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-edit");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam, club.Alex, club.Jo]);
        var organiser = club.Client(f, club.Organiser);
        await RecordAsync(organiser, booking, [U(club.Organiser), U(club.Sam)], [U(club.Alex), U(club.Jo)]);
        var row = (await ResultRowAsync(f, booking))!;
        await club.SetDueAsync(f, row.Id, DateTimeOffset.UtcNow.AddHours(1)); // an hour left: the edit must restart it
        var version = (await ReadResultAsync(organiser, booking)).GetProperty("result").GetProperty("version").GetInt32();

        var edit = new { expectedVersion = version, format = "best_of_3", sideA = new[] { U(club.Sam), U(club.Organiser) }, sideB = new[] { U(club.Alex), U(club.Jo) }, games = G((11, 3), (11, 4)) };
        var jo = await club.Client(f, club.Jo).PutAsJsonAsync($"/api/v1/bookings/{booking}/result", edit);
        Assert.True(jo.StatusCode == HttpStatusCode.Forbidden, $"{(int)jo.StatusCode} {await jo.Content.ReadAsStringAsync()}");
        var stale = await club.Client(f, club.Sam).PutAsJsonAsync($"/api/v1/bookings/{booking}/result", edit with { expectedVersion = version - 1 });
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal("result_changed", (await stale.JsonAsync()).GetProperty("error").GetString());

        var edited = await club.Client(f, club.Sam).PutAsJsonAsync($"/api/v1/bookings/{booking}/result", edit);
        Assert.True(edited.StatusCode == HttpStatusCode.OK, $"{(int)edited.StatusCode} {await edited.Content.ReadAsStringAsync()}");
        var after = (await ResultRowAsync(f, booking))!;
        Assert.Equal(club.Sam, after.SubmittedByUserId);
        Assert.Equal(club.Organiser, after.RecordedByUserId);
        Assert.Equal("best_of_3", after.Format);
        Assert.Equal(version + 1, after.Version);
        Assert.Equal(after.EditedAt!.Value.AddHours(48), after.ConfirmDueAt);
        Assert.True(after.ConfirmDueAt > DateTimeOffset.UtcNow.AddHours(47));
    }

    [SkippableFact]
    public async Task Confirm_dispute_and_withdraw_belong_to_their_sides_and_a_double_tap_confirms_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-actions");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        var organiser = club.Client(f, club.Organiser);
        var sam = club.Client(f, club.Sam);
        var v = (await (await RecordAsync(organiser, booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync()).GetProperty("version").GetInt32();

        Assert.Equal("result_not_yours_to_confirm", (await (await ActAsync(organiser, booking, "confirm", v)).JsonAsync()).GetProperty("error").GetString());
        Assert.Equal("result_not_yours_to_confirm", (await (await ActAsync(organiser, booking, "dispute", v)).JsonAsync()).GetProperty("error").GetString());
        Assert.Equal("result_not_yours", (await (await ActAsync(sam, booking, "withdraw", v)).JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await ActAsync(sam, booking, "withdraw", v)).StatusCode);

        var first = await ActAsync(sam, booking, "confirm", v);
        var second = await ActAsync(sam, booking, "confirm", v);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var row = (await ResultRowAsync(f, booking))!;
        Assert.Equal(("confirmed", club.Sam, v + 1), (row.Status, row.ConfirmedByUserId!.Value, row.Version));
        Assert.Single(await InboxAsync(f, club.Organiser, MemberEventCatalogue.ResultConfirmed));

        // Confirmed is immutable to members.
        Assert.Equal("result_not_pending", (await (await ActAsync(sam, booking, "dispute", v + 1)).JsonAsync()).GetProperty("error").GetString());
        Assert.Equal("result_not_pending", (await (await ActAsync(organiser, booking, "withdraw", v + 1)).JsonAsync()).GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task A_dispute_carries_its_note_a_withdrawal_frees_the_booking_for_a_new_record()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-dispute");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        var organiser = club.Client(f, club.Organiser);
        var sam = club.Client(f, club.Sam);
        var v = (await (await RecordAsync(organiser, booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync()).GetProperty("version").GetInt32();

        var tooLong = await ActAsync(sam, booking, "dispute", v, new string('n', 281));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Equal(280, (await tooLong.JsonAsync()).GetProperty("max").GetInt32());

        var disputed = await (await ActAsync(sam, booking, "dispute", v, "It was 3-2 to me")).JsonAsync();
        Assert.Equal("disputed", disputed.GetProperty("status").GetString());
        Assert.Equal("It was 3-2 to me", disputed.GetProperty("dispute_note").GetString());
        Assert.Equal(HttpStatusCode.OK, (await ActAsync(sam, booking, "dispute", v)).StatusCode);
        Assert.Single(await InboxAsync(f, club.Organiser, MemberEventCatalogue.ResultDisputed));

        // A disputed result never auto-confirms.
        await PlayKit.TickAsync(f, DateTimeOffset.UtcNow.AddDays(10));
        Assert.Equal(MatchResultStatus.Disputed, (await ResultRowAsync(f, booking))!.Status);

        var withdrawn = await ActAsync(organiser, booking, "withdraw", v + 1);
        Assert.Equal("withdrawn", (await withdrawn.JsonAsync()).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.OK, (await ActAsync(organiser, booking, "withdraw", v + 1)).StatusCode);

        var read = await ReadResultAsync(organiser, booking);
        Assert.Equal("withdrawn", read.GetProperty("result").GetProperty("status").GetString());
        Assert.True(read.GetProperty("permissions").GetProperty("can_record").GetBoolean());
        var again = await RecordAsync(organiser, booking, [U(club.Organiser)], [U(club.Sam)]);
        Assert.Equal(HttpStatusCode.Created, again.StatusCode);
        Assert.Equal(v + 3, (await again.JsonAsync()).GetProperty("version").GetInt32());
    }

    /// <summary>The deadline is the instant: a dispute arriving after it finds the result already confirmed.</summary>
    [SkippableFact]
    public async Task A_dispute_after_the_deadline_is_refused_however_recently_the_sweep_ran()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-late");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        var v = (await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync()).GetProperty("version").GetInt32();
        var row = (await ResultRowAsync(f, booking))!;
        await PlayKit.TickAsync(f, DateTimeOffset.UtcNow); // the sweep ran a moment ago: nothing was due
        await club.SetDueAsync(f, row.Id, DateTimeOffset.UtcNow.AddMilliseconds(-5));

        var late = await ActAsync(club.Client(f, club.Sam), booking, "dispute", v, "no");
        Assert.Equal(HttpStatusCode.Conflict, late.StatusCode);
        var body = await late.JsonAsync();
        Assert.Equal(("result_not_pending", "confirmed"), (body.GetProperty("error").GetString(), body.GetProperty("status").GetString()));
        var after = (await ResultRowAsync(f, booking))!;
        Assert.True(after.AutoConfirmed);
        Assert.Equal(row.Id, after.Id);
    }

    /// <summary>Exactly the instant: one microsecond before the deadline it is pending, at it confirmed at the deadline itself.</summary>
    [SkippableFact]
    public async Task Auto_confirmation_happens_at_the_deadline_instant_and_not_a_microsecond_before()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-instant");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]);
        var due = (await ResultRowAsync(f, booking))!.ConfirmDueAt!.Value;

        var early = await club.InClubAsync(f, async sp =>
        {
            var svc = sp.GetRequiredService<ResultService>();
            return (await svc.SettleDueAsync((await svc.CurrentAsync(booking, default))!, due.AddTicks(-10), default)).Changed;
        });
        Assert.False(early);
        Assert.Equal(MatchResultStatus.Pending, (await ResultRowAsync(f, booking))!.Status);

        var onTime = await club.InClubAsync(f, async sp =>
        {
            var svc = sp.GetRequiredService<ResultService>();
            return (await svc.SettleDueAsync((await svc.CurrentAsync(booking, default))!, due, default)).Changed;
        });
        Assert.True(onTime);
        var row = (await ResultRowAsync(f, booking))!;
        Assert.Equal((MatchResultStatus.Confirmed, due, (Guid?)null), (row.Status, row.ConfirmedAt!.Value, row.ConfirmedByUserId));
    }

    [SkippableFact]
    public async Task Any_read_past_the_deadline_confirms_the_result_in_its_own_save()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-lazy");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]);
        var row = (await ResultRowAsync(f, booking))!;
        var due = DateTimeOffset.UtcNow.AddMinutes(-3).Storable();
        await club.SetDueAsync(f, row.Id, due);

        var read = (await ReadResultAsync(club.Client(f, club.Sam), booking)).GetProperty("result");
        Assert.Equal("confirmed", read.GetProperty("status").GetString());
        Assert.True(read.GetProperty("auto_confirmed").GetBoolean());
        Assert.Equal(due, (await ResultRowAsync(f, booking))!.ConfirmedAt);
        // Everybody in the lineup hears of an automatic confirmation.
        Assert.Single(await InboxAsync(f, club.Sam, MemberEventCatalogue.ResultConfirmed));
        Assert.Single(await InboxAsync(f, club.Organiser, MemberEventCatalogue.ResultConfirmed));
    }

    /// <summary>A confirm and the sweep race: one save wins, the loser re-reads and answers from the winner's row.</summary>
    [SkippableFact]
    public async Task A_confirmation_racing_the_sweep_loses_cleanly()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-race");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]);
        var due = (await ResultRowAsync(f, booking))!.ConfirmDueAt!.Value;

        var (changed, status) = await club.InClubAsync(f, async sp =>
        {
            var svc = sp.GetRequiredService<ResultService>();
            var stale = (await svc.CurrentAsync(booking, default))!; // read before the sweep…
            await club.InClubAsync(f, async sweep =>                // …the sweep confirms…
                (await sweep.GetRequiredService<ResultService>().SettleDueAsync(
                    (await sweep.GetRequiredService<ResultService>().CurrentAsync(booking, default))!, due, default)).Changed);
            var (r, c) = await svc.SettleDueAsync(stale, due, default); // …and the stale writer loses.
            return (c, r.Status);
        });
        Assert.False(changed);
        Assert.Equal(MatchResultStatus.Confirmed, status);
        Assert.Single(await InboxAsync(f, club.Sam, MemberEventCatalogue.ResultConfirmed));
    }

    [SkippableFact]
    public async Task A_removed_seat_can_no_longer_see_or_confirm_and_a_stranger_gets_404()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "pr-removed");
        var booking = await club.GameAsync(f, Earlier(), club.Organiser, [club.Sam]);
        var v = (await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync()).GetProperty("version").GetInt32();
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.BookingId == booking && p.UserId == club.Sam).Status = ParticipantStatus.Removed);

        Assert.Equal(HttpStatusCode.NotFound, (await ActAsync(club.Client(f, club.Sam), booking, "confirm", v)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Sam).GetAsync($"/api/v1/bookings/{booking}/result")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Bystander).GetAsync($"/api/v1/bookings/{booking}/result")).StatusCode);
        Assert.Equal(MatchResultStatus.Pending, (await ResultRowAsync(f, booking))!.Status);
    }
}
