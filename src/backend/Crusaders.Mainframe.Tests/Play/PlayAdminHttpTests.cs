using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// The admin's side of play (<c>docs/specs/play.md</c> §6.3–6.4): lists and counts by status, void
/// and uphold with a reason and their change-record rows, non-admins refused, a void freeing the
/// booking, the member summary's counts, and the seven settings.
/// </summary>
public sealed class PlayAdminHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<(Guid Booking, JsonElement Result)> DisputedAsync(PlayersClub club, TestWebAppFactory f, int hoursAgo)
    {
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-hoursAgo).Storable(), club.Organiser, [club.Sam]);
        var r = await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        var d = await (await ActAsync(club.Client(f, club.Sam), booking, "dispute", r.GetProperty("version").GetInt32(), "not the score")).JsonAsync();
        return (booking, d);
    }

    [SkippableFact]
    public async Task The_list_and_the_count_are_by_status_disputed_oldest_first_and_admins_only()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ad-list");
        var admin = club.Client(f, club.Admin, admin: true);
        var (_, first) = await DisputedAsync(club, f, 10);
        var (_, second) = await DisputedAsync(club, f, 5);
        var pending = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        await RecordAsync(club.Client(f, club.Organiser), pending, [U(club.Organiser)], [U(club.Sam)]);

        var list = await (await admin.GetAsync("/api/v1/admin/play/results")).JsonAsync();
        Assert.Equal(2, list.GetProperty("count").GetInt32());
        Assert.Equal([first.GetProperty("result_id").GetGuid(), second.GetProperty("result_id").GetGuid()],
            list.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("result_id").GetGuid()));
        var row = list.GetProperty("items")[0];
        Assert.Equal("Court 1", row.GetProperty("court_name").GetString());
        Assert.Equal(club.Organiser, row.GetProperty("organiser").GetProperty("user_id").GetGuid());
        Assert.Equal("not the score", row.GetProperty("dispute_note").GetString());
        Assert.False(row.TryGetProperty("viewer_side", out _));

        Assert.Equal(1, (await (await admin.GetAsync("/api/v1/admin/play/results?status=pending")).JsonAsync()).GetProperty("count").GetInt32());
        Assert.Equal(3, (await (await admin.GetAsync("/api/v1/admin/play/results?status=all")).JsonAsync()).GetProperty("count").GetInt32());
        Assert.Equal(2, (await (await admin.GetAsync("/api/v1/admin/play/results/disputed/count")).JsonAsync()).GetProperty("count").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync("/api/v1/admin/play/results?status=nonsense")).StatusCode);

        var member = club.Client(f, club.Organiser);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync("/api/v1/admin/play/results")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync("/api/v1/admin/play/results/disputed/count")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.PostAsJsonAsync($"/api/v1/admin/play/results/{first.GetProperty("result_id").GetGuid()}/void", new { reason = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync($"/api/v1/admin/members/{club.Sam}/play")).StatusCode);
    }

    [SkippableFact]
    public async Task A_void_needs_a_reason_is_recorded_once_frees_the_booking_and_a_withdrawn_result_is_not_voidable()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ad-void");
        var admin = club.Client(f, club.Admin, admin: true);
        var (booking, result) = await DisputedAsync(club, f, 4);
        var id = result.GetProperty("result_id").GetGuid();

        Assert.Equal("reason_required", (await (await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{id}/void", new { reason = "  " })).JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{id}/void", new { reason = new string('r', 501) })).StatusCode);

        var voided = await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{id}/void", new { reason = "Both players asked" });
        Assert.Equal(HttpStatusCode.OK, voided.StatusCode);
        var body = await voided.JsonAsync();
        Assert.Equal(("voided", true), (body.GetProperty("status").GetString(), body.GetProperty("closed_by_admin").GetBoolean()));
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{id}/void", new { reason = "again" })).StatusCode);

        var log = await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(l => l.TenantId == club.TenantId && l.Action == AdminChangeActions.PlayResultVoided).ToListAsync());
        var row = Assert.Single(log);
        Assert.Equal((AdminChangeAreas.Play, AdminChangeSubjects.MatchResult, id, "Both players asked", club.Admin),
            (row.Area, row.SubjectKind, row.SubjectId!.Value, row.Reason, row.ActorUserId));
        var after = JsonDocument.Parse(row.AfterJson!).RootElement;
        // Wave B: the status on BOTH sides — the record read "Disputed → —".
        Assert.Equal("disputed", JsonDocument.Parse(row.BeforeJson!).RootElement.GetProperty("status").GetString());
        Assert.Equal("voided", after.GetProperty("status").GetString());
        Assert.False(after.TryGetProperty("from_status", out _));
        Assert.Equal(club.Organiser, after.GetProperty("subject_user_id").GetGuid());
        Assert.Equal([club.Organiser, club.Sam], after.GetProperty("lineup_user_ids").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal(4, after.GetProperty("games").GetArrayLength());

        // The booking is free for a new record, inside the window.
        Assert.Equal(HttpStatusCode.Created, (await RecordAsync(club.Client(f, club.Sam), booking, [U(club.Sam)], [U(club.Organiser)])).StatusCode);

        // A withdrawn result is the member's own closing: not the club's to void.
        var other = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-8).Storable(), club.Organiser, [club.Sam]);
        var r = await (await RecordAsync(club.Client(f, club.Organiser), other, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        await ActAsync(club.Client(f, club.Organiser), other, "withdraw", r.GetProperty("version").GetInt32());
        var refused = await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{r.GetProperty("result_id").GetGuid()}/void", new { reason = "x" });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var refusal = await refused.JsonAsync();
        Assert.Equal(("result_not_voidable", "withdrawn"), (refusal.GetProperty("error").GetString(), refusal.GetProperty("status").GetString()));
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{Guid.NewGuid()}/void", new { reason = "x" })).StatusCode);
    }

    [SkippableFact]
    public async Task An_uphold_keeps_a_disputed_result_confirmed_and_only_a_disputed_one()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ad-uphold");
        var admin = club.Client(f, club.Admin, admin: true);
        var (_, result) = await DisputedAsync(club, f, 4);
        var id = result.GetProperty("result_id").GetGuid();

        var kept = await (await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{id}/uphold", new { reason = "Scoresheet agrees" })).JsonAsync();
        Assert.Equal(("confirmed", true), (kept.GetProperty("status").GetString(), kept.GetProperty("closed_by_admin").GetBoolean()));
        var upheld = Assert.Single(await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(l => l.TenantId == club.TenantId && l.Action == AdminChangeActions.PlayResultUpheld).ToListAsync()));
        var status = Assert.Single(Crusaders.Mainframe.Api.Endpoints.AdminChangeDiff.Of(upheld.BeforeJson, upheld.AfterJson), c => c.Field == "status");
        Assert.Equal(("disputed", "confirmed"), (status.Before, status.After));
        Assert.Equal(1, (await MyGameAsync(club.Client(f, club.Organiser))).GetProperty("stats").GetProperty("matches_won").GetInt32());

        var again = await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{id}/uphold", new { reason = "x" });
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        var refusal = await again.JsonAsync();
        Assert.Equal(("result_not_disputed", "confirmed"), (refusal.GetProperty("error").GetString(), refusal.GetProperty("status").GetString()));
    }

    [SkippableFact]
    public async Task The_member_summary_is_counts_only()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ad-summary");
        await DisputedAsync(club, f, 4);
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-8).Storable(), club.Organiser, [club.Sam]);
        var r = await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        await ActAsync(club.Client(f, club.Sam), booking, "confirm", r.GetProperty("version").GetInt32());

        var admin = club.Client(f, club.Admin, admin: true);
        var summary = await (await admin.GetAsync($"/api/v1/admin/members/{club.Sam}/play")).JsonAsync();
        Assert.Equal(
            ["sessions_attended", "minutes_this_month", "minutes_all_time", "current_streak_weeks", "matches_played", "matches_won", "matches_lost", "open_disputes", "badges_earned"],
            summary.EnumerateObject().Select(p => p.Name));
        Assert.Equal((2, 120, 1, 0, 1, 1), (summary.GetProperty("sessions_attended").GetInt32(), summary.GetProperty("minutes_all_time").GetInt32(),
            summary.GetProperty("matches_played").GetInt32(), summary.GetProperty("matches_won").GetInt32(), summary.GetProperty("matches_lost").GetInt32(),
            summary.GetProperty("open_disputes").GetInt32()));
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"/api/v1/admin/members/{Guid.NewGuid()}/play")).StatusCode);
    }

    [SkippableFact]
    public async Task The_seven_settings_render_clamped_and_are_bounded_on_the_put()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ad-settings", "\"result_autoconfirm_hours\":1");
        var admin = club.Client(f, club.Admin, admin: true);
        var settings = await (await admin.GetAsync("/api/v1/admin/settings/")).JsonAsync();
        Assert.Equal(12, settings.GetProperty("result_autoconfirm_hours").GetInt32());
        Assert.Equal(7, settings.GetProperty("result_record_days").GetInt32());
        Assert.Equal(1260, settings.GetProperty("play_night_owl_from_minute").GetInt32());

        Dictionary<string, object> Body(string key, int value)
        {
            // The PUT's economics keys are required; everything else omitted is unchanged.
            return new Dictionary<string, object>
            {
                ["sliceMinutes"] = settings.GetProperty("slice_minutes").GetInt32(),
                ["advanceBookingDays"] = settings.GetProperty("advance_booking_days").GetInt32(),
                ["dayStartMinute"] = settings.GetProperty("day_start_minute").GetInt32(),
                ["dayEndMinute"] = settings.GetProperty("day_end_minute").GetInt32(),
                ["penaltyPct"] = settings.GetProperty("penalty_pct").GetDecimal(),
                ["graceWindowMinutes"] = settings.GetProperty("grace_window_minutes").GetInt32(),
                ["penaltyWindowMinutes"] = settings.GetProperty("penalty_window_minutes").GetInt32(),
                [key] = value,
            };
        }

        foreach (var (key, min, max) in PlaySettings.Bounds)
        {
            foreach (var bad in new[] { min - 1, max + 1 })
            {
                var response = await admin.PutAsJsonAsync("/api/v1/admin/settings/", Body(key, bad));
                Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
                Assert.Equal($"{key}_out_of_range", (await response.JsonAsync()).GetProperty("error").GetString());
            }
        }
        var ok = await admin.PutAsJsonAsync("/api/v1/admin/settings/", Body("streak_rest_cap", 0));
        Assert.True(ok.IsSuccessStatusCode, await ok.Content.ReadAsStringAsync());
        ok = await admin.PutAsJsonAsync("/api/v1/admin/settings/", Body("result_autoconfirm_hours", 24));
        Assert.True(ok.IsSuccessStatusCode, await ok.Content.ReadAsStringAsync());
        settings = await (await admin.GetAsync("/api/v1/admin/settings/")).JsonAsync();
        Assert.Equal((0, 24), (settings.GetProperty("streak_rest_cap").GetInt32(), settings.GetProperty("result_autoconfirm_hours").GetInt32()));
    }
}
