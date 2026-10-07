using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 3, A-2: the console offers "Approve application" on a rejected applicant and
/// the hint tells the admin to approve — and the server refused anything but
/// <see cref="MembershipStatus.PendingApproval"/> with a bare 404. A rejection is a decision a
/// club can change its mind about; approving one is the same approval, audited, on the change
/// record (from <c>rejected</c>) and mailed exactly as a first-time approval is.
/// </summary>
public sealed class R3MemberDecisionsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableFact]
    public async Task A_rejected_applicant_can_be_approved_and_it_is_recorded_and_mailed_like_any_approval()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var mail = new StubEmailService();
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, mail);
        var club = await MemberCodeClub.SeedAsync(app, "r3approverej");
        var admin = club.Member(app, club.AdminId, "admin");

        await club.WriteAsync(app, async db =>
        {
            var m = await db.Memberships.IgnoreQueryFilters().SingleAsync(x => x.Id == club.SidMembership);
            m.Status = MembershipStatus.PendingApproval;
        });
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(
            $"/api/v1/admin/members/{club.SidMembership}/reject", new { reason = "Could not confirm membership" })).StatusCode);
        mail.Clear();

        var approved = await admin.PostAsync($"/api/v1/admin/members/{club.SidMembership}/approve", null);

        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
        Assert.True((await MemberCodeClub.JsonAsync(approved)).GetProperty("member_email_queued").GetBoolean());
        var row = await club.ReadAsync(app, db => db.Memberships.IgnoreQueryFilters().AsNoTracking().SingleAsync(m => m.Id == club.SidMembership));
        Assert.Equal(MembershipStatus.Active, row.Status);
        Assert.Null(row.RejectionReason);
        Assert.Equal(club.AdminId, row.ReviewedByUserId);

        var change = await club.ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(c => c.TenantId == club.TenantId && c.Action == AdminChangeActions.MemberApproved).SingleAsync());
        Assert.Equal(club.Sid, change.SubjectId);
        Assert.Contains("rejected", change.BeforeJson ?? "", StringComparison.Ordinal);
        Assert.Contains("active", change.AfterJson ?? "", StringComparison.Ordinal);
        Assert.True(await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.SubjectUserId == club.Sid && a.Action == "member.approved")));

        Assert.Single(mail.Sent, m => m.To.StartsWith("sid-", StringComparison.Ordinal) && m.Subject.StartsWith("Welcome to", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task An_active_member_still_cannot_be_approved_again()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r3approveact");
        var admin = club.Member(app, club.AdminId, "admin");

        var again = await admin.PostAsync($"/api/v1/admin/members/{club.OlgaMembership}/approve", null);

        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        Assert.Empty(await club.ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(c => c.TenantId == club.TenantId).ToListAsync()));
    }
}
