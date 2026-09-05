using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The admin-driven member lifecycle: approve, reject, <b>suspend</b>, reactivate — and the
/// <c>member.*</c> webhook events that mirror each of them.
///
/// <para>
/// Two defects sit behind this file. Suspend did not exist at all: <c>MembershipStatus.Suspended</c>
/// was a lone enum value, the members console offered a "Suspended" filter that could never
/// return a row, and spec §8's "approve / reject / suspend" was two thirds true — a club whose
/// member stopped paying had no way to lock them out. And <b>no member lifecycle event was
/// ever emitted</b>: <c>member.approved</c> and <c>member.rejected</c> existed only as audit
/// actions, so CLAUDE.md's "webhooks are a programmatic mirror of the same event stream" had
/// nothing to mirror across the half of the system a club operates by hand.
/// </para>
/// </summary>
public class MemberLifecycleTests
{
    private static List<DomainEvent> Drain(TestHost host)
    {
        var bus = host.Services.GetRequiredService<IEventBus>();
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        return emitted;
    }

    private static async Task<Membership> PendingApplicantAsync(TestHost host, MainframeDbContext db)
    {
        var user = new User { TenantId = host.Tenant.Id, Email = $"applicant-{Guid.NewGuid():N}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(user);
        var membership = new Membership
        {
            TenantId = host.Tenant.Id,
            UserId = user.Id,
            FullName = "Pending Applicant",
            MembershipNumber = $"MEM-{Guid.NewGuid():N}"[..10],
            Status = MembershipStatus.PendingApproval,
        };
        db.Memberships.Add(membership);
        await db.SaveChangesAsync();
        return membership;
    }

    private static Task<Membership> ActiveMemberAsync(MainframeDbContext db, TestHost host) =>
        db.Memberships.FirstAsync(m => m.UserId == host.PlayerUser.Id);

    [Fact]
    public async Task Approving_and_rejecting_each_emit_their_event()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var svc = scope.ServiceProvider.GetRequiredService<MemberApprovalService>();

        var approved = await PendingApplicantAsync(host, db);
        var rejected = await PendingApplicantAsync(host, db);
        Drain(host);

        Assert.True(await svc.ApproveAsync(approved.Id, host.AdminUser.Id, default));
        Assert.Equal(MembershipTransition.Ok, await svc.SuspendAsync(approved.Id, host.AdminUser.Id, "Dues unpaid since March.", default));
        Assert.True(await svc.RejectAsync(rejected.Id, host.AdminUser.Id, "Membership number not on file.", default));

        var types = Drain(host).Select(e => e.Type).ToList();
        Assert.Contains("member.approved", types);
        Assert.Contains("member.suspended", types);
        Assert.Contains("member.rejected", types);
    }

    /// <summary>
    /// The event carries what a downstream consumer needs to act on, and the reason where
    /// there is one. Payload shape is shared across every <c>member.*</c> event so a URL
    /// template written against one works against the others.
    /// </summary>
    [Fact]
    public async Task The_suspension_event_names_the_member_and_the_reason()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var svc = scope.ServiceProvider.GetRequiredService<MemberApprovalService>();
        var membership = await ActiveMemberAsync(db, host);
        Drain(host);

        Assert.Equal(MembershipTransition.Ok, await svc.SuspendAsync(membership.Id, host.AdminUser.Id, "Dues unpaid.", default));

        var evt = Assert.Single(Drain(host), e => e.Type == "member.suspended");
        Assert.Equal(membership.Id, evt.Data["membership_id"]);
        Assert.Equal(host.PlayerUser.Id, evt.Data["user_id"]);
        Assert.Equal("Suspended", evt.Data["status"]);
        Assert.Equal("Dues unpaid.", evt.Data["reason"]);
        Assert.Equal(host.PlayerUser.Id, evt.SubjectUserId);
        Assert.True(evt.ActorIsAdmin);
    }

    /// <summary>
    /// A suspension is audited, emails the member, and is reversible — the row, the ledger
    /// and the bookings are untouched, which is the whole difference between suspending
    /// somebody and rejecting them.
    /// </summary>
    [Fact]
    public async Task Suspending_is_audited_emailed_and_reversible()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var svc = scope.ServiceProvider.GetRequiredService<MemberApprovalService>();
        var membership = await ActiveMemberAsync(db, host);

        Assert.Equal(MembershipTransition.Ok, await svc.SuspendAsync(membership.Id, host.AdminUser.Id, "Dues unpaid.", default));
        await db.Entry(membership).ReloadAsync();
        Assert.Equal(MembershipStatus.Suspended, membership.Status);

        var suspendAudit = await db.AuditLogs.FirstOrDefaultAsync(a => a.Action == "member.suspended" && a.SubjectUserId == host.PlayerUser.Id);
        Assert.NotNull(suspendAudit);
        Assert.Equal(host.AdminUser.Id, suspendAudit!.ActorUserId);
        Assert.Contains("Dues unpaid.", suspendAudit.DetailsJson);
        Assert.Contains(host.EmailService.Sent, m => m.To == host.PlayerUser.Email && m.Subject.Contains("suspended"));

        Assert.Equal(MembershipTransition.Ok, await svc.ReactivateAsync(membership.Id, host.AdminUser.Id, default));
        await db.Entry(membership).ReloadAsync();
        Assert.Equal(MembershipStatus.Active, membership.Status);
        Assert.NotNull(await db.AuditLogs.FirstOrDefaultAsync(a => a.Action == "member.reactivated" && a.SubjectUserId == host.PlayerUser.Id));
    }

    /// <summary>
    /// Suspend and reactivate only move between the two states they name. A pending
    /// applicant is not suspendable — approve or reject them — and a rejected application
    /// is not reactivatable, because turning one into an active member from that route
    /// would skip the approval the club owes it.
    /// </summary>
    [Fact]
    public async Task A_transition_from_the_wrong_status_is_refused_and_distinguishable()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var svc = scope.ServiceProvider.GetRequiredService<MemberApprovalService>();

        var pending = await PendingApplicantAsync(host, db);
        Assert.Equal(MembershipTransition.WrongStatus, await svc.SuspendAsync(pending.Id, host.AdminUser.Id, "reason", default));
        Assert.Equal(MembershipTransition.WrongStatus, await svc.ReactivateAsync(pending.Id, host.AdminUser.Id, default));
        Assert.Equal(MembershipTransition.NotFound, await svc.SuspendAsync(Guid.NewGuid(), host.AdminUser.Id, "reason", default));

        var active = await ActiveMemberAsync(db, host);
        Assert.Equal(MembershipTransition.AlreadyInState, await svc.ReactivateAsync(active.Id, host.AdminUser.Id, default));
        Assert.Equal(MembershipTransition.Ok, await svc.SuspendAsync(active.Id, host.AdminUser.Id, "Dues unpaid.", default));
        Assert.Equal(MembershipTransition.AlreadyInState, await svc.SuspendAsync(active.Id, host.AdminUser.Id, "again", default));
    }

    /// <summary>
    /// Sign-in refuses a suspended member. This already held before suspension could be
    /// SET — which is precisely why it needs a test now: the enforcement and the operation
    /// shipped years apart, and nothing proved they meet.
    /// </summary>
    [Fact]
    public async Task A_suspended_member_cannot_sign_in()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var svc = scope.ServiceProvider.GetRequiredService<MemberApprovalService>();
        var auth = scope.ServiceProvider.GetRequiredService<AuthService>();

        Assert.IsType<LoginResult.Ok>(await auth.LoginAsync(host.PlayerUser.Email, "PlayerPass!", default));

        var membership = await ActiveMemberAsync(db, host);
        Assert.Equal(MembershipTransition.Ok, await svc.SuspendAsync(membership.Id, host.AdminUser.Id, "Dues unpaid.", default));

        var refused = Assert.IsType<LoginResult.NotApproved>(await auth.LoginAsync(host.PlayerUser.Email, "PlayerPass!", default));
        Assert.Equal(MembershipStatus.Suspended, refused.Status);

        Assert.Equal(MembershipTransition.Ok, await svc.ReactivateAsync(membership.Id, host.AdminUser.Id, default));
        Assert.IsType<LoginResult.Ok>(await auth.LoginAsync(host.PlayerUser.Email, "PlayerPass!", default));
    }

    /// <summary>
    /// A suspended member cannot be identified at a court box, on any of the three
    /// identification legs, because their booking leaves the candidate set that PIN,
    /// biometric and QR all resolve against.
    /// </summary>
    [Fact]
    public async Task A_suspended_members_booking_leaves_the_court_candidate_set()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var svc = scope.ServiceProvider.GetRequiredService<MemberApprovalService>();
        var activation = scope.ServiceProvider.GetRequiredService<CourtActivationService>();

        var now = DateTimeOffset.UtcNow;
        var court = host.Courts[0];
        db.Bookings.Add(new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = court.Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            StartsAt = now.AddMinutes(2),
            EndsAt = now.AddMinutes(17),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = BookingStatus.Booked,
        });
        await db.SaveChangesAsync();

        Assert.Single(await activation.CandidatesAsync(court.Id, now, default));
        Assert.NotNull(await activation.FindForUserAsync(court.Id, host.PlayerUser.Id, now, default));

        var membership = await ActiveMemberAsync(db, host);
        Assert.Equal(MembershipTransition.Ok, await svc.SuspendAsync(membership.Id, host.AdminUser.Id, "Dues unpaid.", default));

        Assert.Empty(await activation.CandidatesAsync(court.Id, now, default));
        Assert.Null(await activation.FindForUserAsync(court.Id, host.PlayerUser.Id, now, default));

        // And it comes back on reactivation — the booking was never touched.
        Assert.Equal(MembershipTransition.Ok, await svc.ReactivateAsync(membership.Id, host.AdminUser.Id, default));
        Assert.Single(await activation.CandidatesAsync(court.Id, now, default));
    }

    /// <summary>
    /// Registration tells the club's desk and emits <c>member.registered</c>. Neither
    /// happened: spec §2.3 promises the admin notification and §9 lists the event, and the
    /// registration path sent two emails to the applicant and none to anybody who could act.
    /// </summary>
    [Fact]
    public async Task A_registration_notifies_the_admins_and_emits_its_event()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var auth = scope.ServiceProvider.GetRequiredService<AuthService>();
        Drain(host);
        host.EmailService.Sent.Clear();

        var created = Assert.IsType<RegistrationResult.Created>(
            await auth.RegisterAsync("newcomer@test.local", "Passw0rd!", "New Comer", "MEM-9001", null, default));

        Assert.Contains(host.EmailService.Sent, m => m.To == host.AdminUser.Email && m.Subject.Contains("New membership application"));
        Assert.Contains(host.EmailService.Sent, m => m.To == "newcomer@test.local");

        var evt = Assert.Single(Drain(host), e => e.Type == "member.registered");
        Assert.Equal(created.UserId, evt.Data["user_id"]);
        Assert.Equal("New Comer", evt.Data["full_name"]);
        Assert.Equal("PendingApproval", evt.Data["status"]);
    }
}
