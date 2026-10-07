using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, B5 / B6 / B10: the Change record was missing approve, reject, suspend,
/// reactivate, the temporary password and the desk's code reset (the actions were in the
/// vocabulary and nothing wrote them); the code reset took no reason and told the member nothing;
/// granting admin took no reason while revoking did.
/// </summary>
public sealed class R1ChangeRecordHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<List<AdminChangeLog>> ChangesAsync(MemberCodeClub club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app) =>
        await club.ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(c => c.TenantId == club.TenantId).OrderBy(c => c.OccurredAt).ToListAsync());

    private static async Task<Guid> MembershipOfAsync(MemberCodeClub club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app, Guid user) =>
        await club.ReadAsync(app, db => db.Memberships.IgnoreQueryFilters().Where(m => m.UserId == user).Select(m => m.Id).FirstAsync());

    [SkippableFact]
    public async Task Every_membership_decision_lands_on_the_change_record_with_who_whom_and_why()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r1changes");
        var admin = club.Member(app, club.AdminId, "admin");
        var pam = await MembershipOfAsync(club, app, club.Pam);

        // Two applicants: Pam approved, Sid rejected.
        await club.WriteAsync(app, async db =>
        {
            foreach (var m in await db.Memberships.IgnoreQueryFilters().Where(m => m.Id == pam || m.Id == club.SidMembership).ToListAsync())
                m.Status = MembershipStatus.PendingApproval;
        });
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync($"/api/v1/admin/members/{pam}/approve", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/members/{club.SidMembership}/reject", new { reason = "Not a member of the club" })).StatusCode);

        // Olga suspended, reactivated, given a temporary password.
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/members/{club.OlgaMembership}/suspend", new { reason = "Dues unpaid" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync($"/api/v1/admin/members/{club.OlgaMembership}/reactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync($"/api/v1/admin/members/{club.OlgaMembership}/reset-password", null)).StatusCode);

        var rows = await ChangesAsync(club, app);
        Assert.Equal(
            [AdminChangeActions.MemberApproved, AdminChangeActions.MemberRejected, AdminChangeActions.MemberSuspended,
             AdminChangeActions.MemberReactivated, AdminChangeActions.MemberPasswordReset],
            rows.Select(r => r.Action));
        Assert.All(rows, r => Assert.Equal(club.AdminId, r.ActorUserId));
        Assert.Equal([club.Pam, club.Sid, club.Olga, club.Olga, club.Olga], rows.Select(r => r.SubjectId!.Value));
        Assert.Equal("Not a member of the club", rows[1].Reason);
        Assert.Equal("Dues unpaid", rows[2].Reason);
        Assert.Equal("Olga Organiser", rows[2].SubjectLabel);

        // Readable on the Change record page, with a headline for each.
        var page = await MemberCodeClub.JsonAsync(await admin.GetAsync("/api/v1/admin/changes"));
        var headlines = page.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("headline").GetString()!).ToList();
        Assert.Contains("Approved a member — Pam Payer", headlines);
        Assert.Contains("Suspended a member — Olga Organiser", headlines);
        Assert.Contains("Gave a member a temporary password — Olga Organiser", headlines);
        Assert.DoesNotContain(headlines, h => h.Contains("no word for", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task The_desks_code_reset_needs_a_reason_is_recorded_and_tells_the_member()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var mail = new StubEmailService();
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, mail);
        var club = await MemberCodeClub.SeedAsync(app, "r1codereset");
        var admin = club.Member(app, club.AdminId, "admin");
        var path = $"/api/v1/admin/members/{club.OlgaMembership}/code/reset";

        foreach (var body in new object?[] { null, new { }, new { reason = "   " } })
        {
            var refused = body is null ? await admin.PostAsync(path, null) : await admin.PostAsJsonAsync(path, body);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("reason_required", (await MemberCodeClub.JsonAsync(refused)).GetProperty("error").GetString());
        }
        Assert.Empty(await ChangesAsync(club, app));
        Assert.Equal(1, await club.ReadAsync(app, db => db.MemberCodes.IgnoreQueryFilters().Where(c => c.UserId == club.Olga).Select(c => c.Generation).FirstAsync()));

        var reset = await admin.PostAsJsonAsync(path, new { reason = "Lost her phone at the club" });
        Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        Assert.True((await MemberCodeClub.JsonAsync(reset)).GetProperty("member_email_queued").GetBoolean());

        var row = Assert.Single(await ChangesAsync(club, app));
        Assert.Equal(AdminChangeActions.MemberCodeReset, row.Action);
        Assert.Equal("Lost her phone at the club", row.Reason);
        Assert.Equal(club.Olga, row.SubjectId);

        var sent = Assert.Single(mail.Sent, m => m.To == $"olga-{club.Slug}@test.local");
        Assert.Contains("reset your member code", sent.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Lost her phone at the club", sent.PlainBody ?? sent.HtmlBody);
    }

    [SkippableFact]
    public async Task Granting_admin_needs_a_reason_and_records_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r1grant");
        var admin = club.Member(app, club.AdminId, "admin");
        var path = $"/api/v1/admin/members/{club.Pam}/admin";

        var refused = await admin.PostAsJsonAsync(path, new { grant = true });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("reason_required", (await MemberCodeClub.JsonAsync(refused)).GetProperty("error").GetString());
        Assert.False(await club.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.Id == club.Pam).Select(u => u.IsAdmin).FirstAsync()));

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(path, new { grant = true, reason = "Runs the Tuesday desk" })).StatusCode);
        var row = Assert.Single(await ChangesAsync(club, app));
        Assert.Equal(AdminChangeActions.MemberAdminGranted, row.Action);
        Assert.Equal("Runs the Tuesday desk", row.Reason);
    }

    private sealed class MovableClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    /// <summary>
    /// B19: opening a member's activity or door history wrote two identical rows (React's dev
    /// StrictMode runs the data effect twice; a retry does the same). One row per view: the same
    /// admin asking the same question within the window is folded; a new question, the window
    /// passing, or an export is recorded.
    /// </summary>
    [SkippableFact]
    public async Task Looking_at_a_members_activity_or_doors_twice_in_a_row_is_one_view()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var clock = new MovableClock();
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<TimeProvider>();
            s.AddSingleton<TimeProvider>(clock);
        }));
        var club = await MemberCodeClub.SeedAsync(app, "r1viewonce");
        var admin = club.Member(app, club.AdminId, "admin");

        async Task<int> CountAsync(string action) =>
            (await ChangesAsync(club, app)).Count(r => r.Action == action && r.SubjectId == club.Olga);

        foreach (var (path, action) in new[]
        {
            ($"/api/v1/admin/members/{club.Olga}/trace", AdminChangeActions.MemberTraceViewed),
            ($"/api/v1/admin/members/{club.Olga}/doors", AdminChangeActions.MemberDoorHistoryViewed),
        })
        {
            var twice = await Task.WhenAll(admin.GetAsync(path), admin.GetAsync(path));
            Assert.All(twice, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
            Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(path)).StatusCode);
            Assert.Equal(1, await CountAsync(action));

            // A different question is a different view. For the trace a page size is not a
            // question (review round 4 — its pages are one view), so it asks about another day.
            var other = action == AdminChangeActions.MemberTraceViewed
                ? $"?day={DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-1):yyyy-MM-dd}"
                : "?limit=10";
            Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(path + other)).StatusCode);
            Assert.Equal(2, await CountAsync(action));

            // The same question after the window is looked at again.
            clock.Now = clock.Now.Add(ViewAuditOnce.Window).AddSeconds(1);
            Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(path)).StatusCode);
            Assert.Equal(3, await CountAsync(action));
        }

        // The door page's audit_log row is folded with its change-record row, never split from it.
        var audit = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == club.TenantId && a.Action == AdminChangeActions.MemberDoorHistoryViewed));
        Assert.Equal(3, audit);
    }
}
