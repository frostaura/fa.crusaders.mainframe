using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// R23's admin notice outbox, on the in-process host: who a notice goes to, what a failed send
/// does, what a cooldown withholds, and what the observation sweep raises.
///
/// <para>
/// <b>What is NOT proved here, and where it is.</b> The claim's <c>FOR UPDATE SKIP LOCKED</c>,
/// the unique dedupe index, and "staged in the same save as the event" all rest on a real
/// database — the in-memory provider has no row locks, enforces no index and has no
/// transactions (<c>memory/gotchas.md</c>). Those are <c>AdminNotificationHttpTests</c>.
/// </para>
/// </summary>
public class AdminNotificationTests
{
    private static readonly DateTimeOffset T0 = TestHost.Storable(DateTimeOffset.UtcNow);

    private static async Task<(Guid Id, string Email)> AddPersonAsync(
        TestHost host, string handle, bool isAdmin, bool verified = true, string status = "active", params string[] optouts)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = new User
        {
            TenantId = host.Tenant.Id,
            Email = $"{handle}@{host.Tenant.Slug}.review.test",
            PasswordHash = "x",
            EmailVerified = verified,
            IsAdmin = isAdmin,
            Status = status,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = host.Tenant.Id, UserId = user.Id, FullName = handle,
            MembershipNumber = $"{handle}-{Guid.NewGuid():N}"[..20], Status = MembershipStatus.Active,
        });
        if (optouts.Length > 0)
        {
            db.UserPreferences.Add(new UserPreferences
            {
                TenantId = host.Tenant.Id, UserId = user.Id, AdminNotificationOptoutsJson = JsonSerializer.Serialize(optouts),
            });
        }
        await db.SaveChangesAsync();
        return (user.Id, user.Email);
    }

    private static async Task<Guid> StageAsync(TestHost host, AdminNotice notice, DateTimeOffset? at = null)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = AdminNotices.Stage(db, host.Tenant.Id, notice, at ?? T0);
        await db.SaveChangesAsync();
        return row.Id;
    }

    private static async Task<AdminNotification> RowAsync(TestHost host, Guid id)
    {
        using var scope = host.NewScope();
        return await scope.ServiceProvider.GetRequiredService<MainframeDbContext>()
            .AdminNotifications.IgnoreQueryFilters().AsNoTracking().SingleAsync(n => n.Id == id);
    }

    private static AdminNotice Registration(string name = "Ada Applicant") =>
        AdminNotices.MemberRegistered(Guid.NewGuid(), name, "ada@applicant.review.test", "RR-0001");

    private static AdminNotice Overdraft(Guid actor, Guid member, string court = "Court 1") =>
        AdminNotices.OverdraftAuthorised(Guid.NewGuid(), actor, member, new OverdraftPayload(
            Guid.NewGuid(), "Desk Admin", "Mo Member", Self: actor == member, court, "Tue 29 Sep, 18:00", 45, -90));

    // ------------------------------------------------------------------ recipients

    /// <summary>
    /// The club's active administrators with a confirmed address — not a member, not an admin
    /// whose account is suspended, not one whose address nobody has confirmed.
    /// </summary>
    [Fact]
    public async Task A_notice_goes_to_the_active_confirmed_admins_and_nobody_else()
    {
        await using var host = await TestHost.CreateAsync();
        var second = await AddPersonAsync(host, "second.admin", isAdmin: true);
        var unverified = await AddPersonAsync(host, "unverified.admin", isAdmin: true, verified: false);
        var suspended = await AddPersonAsync(host, "suspended.admin", isAdmin: true, status: "suspended");
        await StageAsync(host, Registration());

        await host.DeliverAdminNoticesAsync(T0);

        var to = host.EmailService.Sent.Select(m => m.To).OrderBy(t => t, StringComparer.Ordinal).ToList();
        Assert.Equal(new[] { host.AdminUser.Email, second.Email }.OrderBy(t => t, StringComparer.Ordinal), to);
        Assert.DoesNotContain(unverified.Email, to);
        Assert.DoesNotContain(suspended.Email, to);
        Assert.DoesNotContain(host.PlayerUser.Email, to);
        Assert.All(host.EmailService.Sent, m => Assert.Equal("New membership application — Ada Applicant", m.Subject));
    }

    [Fact]
    public async Task An_admin_who_opted_out_of_a_kind_is_not_mailed_it_and_still_gets_the_others()
    {
        await using var host = await TestHost.CreateAsync();
        var quiet = await AddPersonAsync(host, "quiet.admin", isAdmin: true, optouts: AdminEventCatalogue.MemberRegistered);
        await StageAsync(host, Registration());
        await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id));

        await host.DeliverAdminNoticesAsync(T0);

        var toQuiet = host.EmailService.Sent.Where(m => m.To == quiet.Email).ToList();
        var mail = Assert.Single(toQuiet);
        Assert.Contains("below zero", mail.Subject, StringComparison.Ordinal);
        Assert.Contains(host.EmailService.Sent, m => m.To == host.AdminUser.Email && m.Subject.StartsWith("New membership", StringComparison.Ordinal));
    }

    /// <summary>
    /// A stored opt-out naming a security kind is ignored at delivery. The PUT refuses one; this
    /// is the other wall, for a row that got one some other way.
    /// </summary>
    [Fact]
    public async Task Nobody_can_opt_out_of_a_security_kind_even_with_a_stored_opt_out()
    {
        await using var host = await TestHost.CreateAsync();
        var stubborn = await AddPersonAsync(host, "stubborn.admin", isAdmin: true, optouts: AdminEventCatalogue.AdminRoleChanged);
        await StageAsync(host, AdminNotices.AdminRoleChanged(
            host.LeaguePlayerUser.Id, host.AdminUser.Id, new AdminRolePayload("Test League", "Test Admin", true, null), T0));

        await host.DeliverAdminNoticesAsync(T0);

        Assert.Single(host.EmailService.Sent, m => m.To == stubborn.Email && m.Subject == "New administrator — Test League");
    }

    [Fact]
    public async Task The_admin_whose_action_it_was_is_not_mailed_about_it()
    {
        await using var host = await TestHost.CreateAsync();
        var colleague = await AddPersonAsync(host, "colleague.admin", isAdmin: true);
        await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id));

        await host.DeliverAdminNoticesAsync(T0);

        var mail = Assert.Single(host.EmailService.Sent);
        Assert.Equal(colleague.Email, mail.To);
        Assert.Equal("Desk Admin took Mo Member below zero", mail.Subject);
        // A real minus sign, U+2212, as every screen prints it (review round 3, A-8), on whole
        // minutes in words (P13): 90 below zero is "−1 hour 30 minutes", never "-90.00 credits".
        var text = MailText.Unwrap(mail.PlainBody);
        Assert.Contains("\u22121 hour 30 minutes", text, StringComparison.Ordinal);
        Assert.Contains("Charged: 45 minutes", text, StringComparison.Ordinal);
        Assert.DoesNotContain("-1 hour", text, StringComparison.Ordinal);
        Assert.DoesNotContain("credit", text, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The rights change's three messages, from the one row: the subject's own, every other
    /// admin's notice, and nothing for the actor — the rules the direct notifier kept.
    /// </summary>
    [Fact]
    public async Task A_rights_change_mails_its_subject_their_own_message_and_the_others_the_notice()
    {
        await using var host = await TestHost.CreateAsync();
        var colleague = await AddPersonAsync(host, "colleague.admin", isAdmin: true);
        await StageAsync(host, AdminNotices.AdminRoleChanged(
            host.PlayerUser.Id, host.AdminUser.Id, new AdminRolePayload("Test Player", "Test Admin", false, "Stepped down"), T0));

        await host.DeliverAdminNoticesAsync(T0);

        var toSubject = Assert.Single(host.EmailService.Sent, m => m.To == host.PlayerUser.Email);
        Assert.Equal("You're no longer an administrator", toSubject.Subject);
        Assert.Contains("Stepped down", MailText.Unwrap(toSubject.PlainBody), StringComparison.Ordinal);
        var toColleague = Assert.Single(host.EmailService.Sent, m => m.To == colleague.Email);
        Assert.Equal("Administrator removed — Test Player", toColleague.Subject);
        Assert.DoesNotContain(host.EmailService.Sent, m => m.To == host.AdminUser.Email);
    }

    /// <summary>
    /// Two clubs in ONE store, so a missing tenant filter would actually have another club's
    /// admins to find. A notice for club A reaches A's desk and never B's.
    /// </summary>
    [Fact]
    public async Task A_notice_reaches_its_own_clubs_admins_and_never_another_clubs()
    {
        var shared = $"notices-{Guid.NewGuid():N}";
        await using var a = await TestHost.CreateAsync("club-a", shared);
        await using var b = await TestHost.CreateAsync("club-b", shared);
        await StageAsync(a, Registration());

        await a.DeliverAdminNoticesAsync(T0);

        Assert.Single(a.EmailService.Sent);
        Assert.Equal(a.AdminUser.Email, a.EmailService.Sent[0].To);
        Assert.DoesNotContain(a.EmailService.Sent, m => m.To == b.AdminUser.Email);
        Assert.Empty(b.EmailService.Sent);
    }

    // ------------------------------------------------------------------ retries

    [Fact]
    public async Task A_failed_send_backs_off_and_is_not_claimed_again_before_it_is_due()
    {
        await using var host = await TestHost.CreateAsync();
        host.EmailService.FailWhen = _ => true;
        var id = await StageAsync(host, Registration());

        await host.DeliverAdminNoticesAsync(T0);

        var row = await RowAsync(host, id);
        Assert.Equal(AdminNotificationState.Pending, row.State);
        Assert.Equal(1, row.Attempts);
        Assert.Equal(T0 + AdminNotificationDispatcher.Backoffs[0], row.DueAt);
        Assert.Null(row.LockedUntil);
        Assert.Contains("SmtpException", row.LastError, StringComparison.Ordinal);

        host.EmailService.FailWhen = null;
        await host.DeliverAdminNoticesAsync(T0.AddSeconds(59));
        Assert.Empty(host.EmailService.Sent);
        Assert.Equal(1, (await RowAsync(host, id)).Attempts);

        await host.DeliverAdminNoticesAsync(T0 + AdminNotificationDispatcher.Backoffs[0]);
        Assert.Single(host.EmailService.Sent);
        var sent = await RowAsync(host, id);
        Assert.Equal(AdminNotificationState.Sent, sent.State);
        Assert.Equal(2, sent.Attempts);
        Assert.Null(sent.LastError);
    }

    /// <summary>
    /// One admin's mailbox refusing must not cost the others a duplicate on the retry — the
    /// retry mails only the admin who did not get it.
    /// </summary>
    [Fact]
    public async Task A_retry_mails_only_the_admins_who_did_not_get_it()
    {
        await using var host = await TestHost.CreateAsync();
        var flaky = await AddPersonAsync(host, "flaky.admin", isAdmin: true);
        host.EmailService.FailWhen = m => m.To == flaky.Email;
        var id = await StageAsync(host, Registration());

        await host.DeliverAdminNoticesAsync(T0);
        Assert.Single(host.EmailService.Sent, m => m.To == host.AdminUser.Email);
        Assert.Equal(1, (await RowAsync(host, id)).RecipientCount);

        host.EmailService.FailWhen = null;
        await host.DeliverAdminNoticesAsync(T0.AddHours(1));

        Assert.Single(host.EmailService.Sent, m => m.To == host.AdminUser.Email);
        Assert.Single(host.EmailService.Sent, m => m.To == flaky.Email);
        var row = await RowAsync(host, id);
        Assert.Equal(AdminNotificationState.Sent, row.State);
        Assert.Equal(2, row.RecipientCount);
    }

    [Fact]
    public async Task A_notice_that_keeps_failing_is_given_up_after_the_last_attempt()
    {
        await using var host = await TestHost.CreateAsync();
        host.EmailService.FailWhen = _ => true;
        var id = await StageAsync(host, Registration());

        var now = T0;
        for (var i = 0; i < AdminNotificationDispatcher.MaxAttempts; i++)
        {
            await host.DeliverAdminNoticesAsync(now);
            now = now.AddDays(1);
        }

        var row = await RowAsync(host, id);
        Assert.Equal(AdminNotificationState.Failed, row.State);
        Assert.Equal(AdminNotificationDispatcher.MaxAttempts, row.Attempts);
        Assert.NotNull(row.SentAt);

        // And it is finished: nothing claims it again.
        host.EmailService.FailWhen = null;
        await host.DeliverAdminNoticesAsync(now.AddDays(30));
        Assert.Empty(host.EmailService.Sent);
    }

    [Fact]
    public async Task A_sent_notice_is_never_mailed_again()
    {
        await using var host = await TestHost.CreateAsync();
        await StageAsync(host, Registration());

        await host.DeliverAdminNoticesAsync(T0);
        await host.DeliverAdminNoticesAsync(T0.AddMinutes(1));
        await host.DeliverAdminNoticesAsync(T0.AddDays(1));

        Assert.Single(host.EmailService.Sent);
    }

    /// <summary>A kind this build does not know is refused, never composed by guesswork.</summary>
    [Fact]
    public async Task A_notice_of_an_unknown_kind_is_failed_and_mails_nobody()
    {
        await using var host = await TestHost.CreateAsync();
        var id = await StageAsync(host, new AdminNotice("device.invented_later", "x:1", new { }, "?", null));

        await host.DeliverAdminNoticesAsync(T0);

        Assert.Empty(host.EmailService.Sent);
        var row = await RowAsync(host, id);
        Assert.Equal(AdminNotificationState.Failed, row.State);
        Assert.Equal("unknown_kind", row.LastError);
    }

    [Fact]
    public async Task A_notice_everybody_opted_out_of_is_sent_to_nobody_and_says_so()
    {
        await using var host = await TestHost.CreateAsync();
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.UserPreferences.Add(new UserPreferences
            {
                TenantId = host.Tenant.Id, UserId = host.AdminUser.Id,
                AdminNotificationOptoutsJson = $"[\"{AdminEventCatalogue.MemberRegistered}\"]",
            });
            await db.SaveChangesAsync();
        }
        var id = await StageAsync(host, Registration());

        await host.DeliverAdminNoticesAsync(T0);

        Assert.Empty(host.EmailService.Sent);
        var row = await RowAsync(host, id);
        Assert.Equal(AdminNotificationState.Sent, row.State);
        Assert.Equal(0, row.RecipientCount);
    }

    // ------------------------------------------------------------------ cooldown

    /// <summary>
    /// One admin overdrawing one member twice inside the window is one mail and two rows; a
    /// different member is a different scope, and the window's end lets the next one through.
    /// </summary>
    [Fact]
    public async Task Inside_the_cooldown_a_second_notice_of_the_same_scope_is_withheld_but_kept()
    {
        await using var host = await TestHost.CreateAsync();
        var colleague = await AddPersonAsync(host, "colleague.admin", isAdmin: true);
        var first = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id), T0);
        var second = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 2"), T0.AddMinutes(5));
        var otherMember = await StageAsync(host, Overdraft(host.AdminUser.Id, host.LeaguePlayerUser.Id), T0.AddMinutes(6));
        var later = await StageAsync(host,
            Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 3"), T0.AddMinutes(AdminNotificationSettings.DefaultOverdraftCooldownMinutes + 1));

        await host.DeliverAdminNoticesAsync(T0.AddHours(1));

        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, first)).State);
        Assert.Equal(AdminNotificationState.Suppressed, (await RowAsync(host, second)).State);
        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, otherMember)).State);
        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, later)).State);
        Assert.Equal(3, host.EmailService.Sent.Count(m => m.To == colleague.Email));
        Assert.DoesNotContain(host.EmailService.Sent, m => m.HtmlBody.Contains("Court 2", StringComparison.Ordinal));
    }

    private static AdminNotice GatewayError(string identity) =>
        AdminNotices.TopUpFailed("gateway_error", identity, 100, "Mo Member", identity);

    /// <summary>
    /// The top-up and overdraft windows are the club's own numbers
    /// (<c>topup_failure_cooldown_minutes</c>, <c>overdraft_cooldown_minutes</c>), not constants: a
    /// club that widens one withholds what the default would have let through, and a club that
    /// narrows one hears what the default would have withheld.
    /// </summary>
    [Fact]
    public async Task The_top_up_and_overdraft_cooldowns_are_the_clubs_own_settings()
    {
        await using var host = await TestHost.CreateAsync();
        var colleague = await AddPersonAsync(host, "colleague.admin", isAdmin: true);
        await PatchSettingsAsync(host, ("overdraft_cooldown_minutes", 60), ("topup_failure_cooldown_minutes", 5));

        // Overdraft: 20 minutes apart is past the default 15, inside the club's 60.
        var firstOverdraft = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id), T0);
        var widened = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 2"), T0.AddMinutes(20));
        var pastWidened = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 3"), T0.AddMinutes(61));

        // Top-up: 10 minutes apart is inside the default 30, past the club's 5.
        var firstTopUp = await StageAsync(host, GatewayError("PF-1"), T0);
        var narrowed = await StageAsync(host, GatewayError("PF-2"), T0.AddMinutes(10));
        var insideNarrowed = await StageAsync(host, GatewayError("PF-3"), T0.AddMinutes(12));

        await host.DeliverAdminNoticesAsync(T0.AddHours(2));

        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, firstOverdraft)).State);
        Assert.Equal(AdminNotificationState.Suppressed, (await RowAsync(host, widened)).State);
        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, pastWidened)).State);
        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, firstTopUp)).State);
        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, narrowed)).State);
        Assert.Equal(AdminNotificationState.Suppressed, (await RowAsync(host, insideNarrowed)).State);
        Assert.Equal(4, host.EmailService.Sent.Count(m => m.To == colleague.Email));
    }

    /// <summary>
    /// With nothing stored the windows are the old constants, 30 and 15 minutes; and a stored
    /// value outside the bounds is clamped on read, so a zero written round the PUT cannot turn
    /// either kind into a mail per event.
    /// </summary>
    [Fact]
    public async Task The_notifier_cooldowns_default_to_the_old_windows_and_are_clamped_on_read()
    {
        var defaults = new TenantSettingsView(15, 30, 5, 15, 14, "UTC", 60, "16:00-19:00", 1, 2, 0, 1440, 7, ButtonMap.Default());
        Assert.Equal(TimeSpan.FromMinutes(30), AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.TopUpFailed, defaults));
        Assert.Equal(TimeSpan.FromMinutes(15), AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.OverdraftAuthorised, defaults));

        var zero = defaults with { TopUpFailureCooldownMinutes = 0, OverdraftCooldownMinutes = 0 };
        Assert.Equal(TimeSpan.FromMinutes(AdminNotificationSettings.MinTopUpFailureCooldownMinutes),
            AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.TopUpFailed, zero));
        Assert.Equal(TimeSpan.FromMinutes(AdminNotificationSettings.MinOverdraftCooldownMinutes),
            AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.OverdraftAuthorised, zero));

        var huge = defaults with { TopUpFailureCooldownMinutes = 1_000_000, OverdraftCooldownMinutes = 1_000_000 };
        Assert.Equal(TimeSpan.FromMinutes(AdminNotificationSettings.MaxTopUpFailureCooldownMinutes),
            AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.TopUpFailed, huge));
        Assert.Equal(TimeSpan.FromMinutes(AdminNotificationSettings.MaxOverdraftCooldownMinutes),
            AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.OverdraftAuthorised, huge));

        // And the accessor reads the stored keys, not only the initialisers.
        await using var host = await TestHost.CreateAsync();
        await PatchSettingsAsync(host, ("topup_failure_cooldown_minutes", 45), ("overdraft_cooldown_minutes", 3));
        using var scope = host.NewScope();
        var read = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        Assert.Equal(TimeSpan.FromMinutes(45), AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.TopUpFailed, read));
        Assert.Equal(TimeSpan.FromMinutes(3), AdminNotificationDispatcher.Cooldown(AdminEventCatalogue.OverdraftAuthorised, read));
    }

    [Fact]
    public async Task Kinds_with_no_cooldown_are_never_withheld()
    {
        await using var host = await TestHost.CreateAsync();
        await StageAsync(host, Registration("First Applicant"));
        await StageAsync(host, Registration("Second Applicant"));

        await host.DeliverAdminNoticesAsync(T0);

        Assert.Equal(2, host.EmailService.Sent.Count);
    }

    // ------------------------------------------------------------------ the sweep

    private static async Task SweepAsync(TestHost host, DateTimeOffset now) =>
        await host.Services.GetRequiredService<AdminNotificationSweep>().SweepAsync(now, default);

    private static async Task<List<AdminNotification>> RowsAsync(TestHost host, string kind)
    {
        using var scope = host.NewScope();
        return await scope.ServiceProvider.GetRequiredService<MainframeDbContext>()
            .AdminNotifications.IgnoreQueryFilters().AsNoTracking()
            .Where(n => n.Kind == kind && n.TenantId == host.Tenant.Id).ToListAsync();
    }

    private static async Task AddApplicationAsync(TestHost host, string name, DateTimeOffset createdAt)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = new User { TenantId = host.Tenant.Id, Email = $"{Guid.NewGuid():N}@applicant.review.test", PasswordHash = "x" };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = host.Tenant.Id, UserId = user.Id, FullName = name, MembershipNumber = $"P-{Guid.NewGuid():N}"[..12],
            Status = MembershipStatus.PendingApproval, CreatedAt = createdAt,
        });
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// The fixture club is at UTC and open from midnight, so "noon" is inside its day. Applications
    /// past the threshold are named by the oldest; one reminder per club date however often the
    /// sweep runs; nothing when none has waited long enough.
    /// </summary>
    [Fact]
    public async Task Waiting_applications_are_reminded_about_once_per_club_day()
    {
        await using var host = await TestHost.CreateAsync();
        var noon = new DateTimeOffset(T0.UtcDateTime.Date.AddHours(12), TimeSpan.Zero);
        await AddApplicationAsync(host, "Fresh Applicant", noon.AddHours(-2));

        await SweepAsync(host, noon);
        Assert.Empty(await RowsAsync(host, AdminEventCatalogue.ApplicationsPending));

        await AddApplicationAsync(host, "Oldest Applicant", noon.AddHours(-50));
        await AddApplicationAsync(host, "Older Applicant", noon.AddHours(-30));
        await SweepAsync(host, noon);
        await SweepAsync(host, noon.AddHours(3));

        var row = Assert.Single(await RowsAsync(host, AdminEventCatalogue.ApplicationsPending));
        var payload = JsonSerializer.Deserialize<ApplicationsPendingPayload>(row.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal(2, payload.Count);
        Assert.Equal("Oldest Applicant", payload.OldestName);
        Assert.Equal(50, payload.OldestHours);

        await SweepAsync(host, noon.AddDays(1));
        Assert.Equal(2, (await RowsAsync(host, AdminEventCatalogue.ApplicationsPending)).Count);

        await host.DeliverAdminNoticesAsync(noon.AddDays(1));
        Assert.Contains(host.EmailService.Sent, m => m.Subject == "2 applications are still waiting");
    }

    [Fact]
    public async Task No_reminder_goes_before_the_club_has_opened_for_the_day()
    {
        await using var host = await TestHost.CreateAsync();
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(s => s.TenantId == host.Tenant.Id);
            row.SettingsJson = row.SettingsJson.Replace("\"day_start_minute\":0", "\"day_start_minute\":480");
            await db.SaveChangesAsync();
        }
        var early = new DateTimeOffset(T0.UtcDateTime.Date.AddHours(7), TimeSpan.Zero);
        await AddApplicationAsync(host, "Oldest Applicant", early.AddDays(-3));

        await SweepAsync(host, early);
        Assert.Empty(await RowsAsync(host, AdminEventCatalogue.ApplicationsPending));

        await SweepAsync(host, early.AddHours(1));
        Assert.Single(await RowsAsync(host, AdminEventCatalogue.ApplicationsPending));
    }

    private static async Task AddFaultsAsync(
        TestHost host, int count, DateTimeOffset lastSeen, DeviceErrorSeverity severity = DeviceErrorSeverity.Error, DateTimeOffset? firstSeen = null)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        for (var i = 0; i < count; i++)
        {
            db.DeviceErrors.Add(new DeviceError
            {
                TenantId = host.Tenant.Id, Code = $"E{i}", Fingerprint = $"fp-{Guid.NewGuid():N}",
                ClaimedDeviceCode = $"box-{i % 2}", Severity = severity, Source = DeviceErrorSource.Device,
                FirstSeenAt = firstSeen ?? lastSeen, LastSeenAt = lastSeen,
            });
        }
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Many_faults_inside_the_window_raise_one_fault_spike_and_fewer_raise_none()
    {
        await using var host = await TestHost.CreateAsync();
        await AddFaultsAsync(host, AdminNotificationSettings.DefaultFaultSpikeCount - 1, T0.AddMinutes(-2));
        // Warnings do not count, however many.
        await AddFaultsAsync(host, 20, T0.AddMinutes(-2), DeviceErrorSeverity.Warning);

        await SweepAsync(host, T0);
        Assert.Empty(await RowsAsync(host, AdminEventCatalogue.FaultSpike));

        await AddFaultsAsync(host, 1, T0.AddMinutes(-1));
        await SweepAsync(host, T0);
        await SweepAsync(host, T0);

        var row = Assert.Single(await RowsAsync(host, AdminEventCatalogue.FaultSpike));
        var payload = JsonSerializer.Deserialize<FaultSpikePayload>(row.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal(AdminNotificationSettings.DefaultFaultSpikeCount, payload.Faults);
        Assert.Contains("box-0", payload.Boards);
    }

    [Fact]
    public async Task Faults_older_than_the_window_do_not_make_a_spike()
    {
        await using var host = await TestHost.CreateAsync();
        await AddFaultsAsync(host, 30, T0.AddMinutes(-(AdminNotificationSettings.DefaultFaultSpikeMinutes + 1)));

        await SweepAsync(host, T0);

        Assert.Empty(await RowsAsync(host, AdminEventCatalogue.FaultSpike));
    }

    /// <summary>
    /// Review F1: faults that opened long ago and are still repeating — a flaky sensor — are not
    /// a spike. Counted by last report, five week-old faults made a "5 device faults in 15
    /// minutes" mail in every window of every day. The control: the same five opening now do.
    /// </summary>
    [Fact]
    public async Task Faults_that_opened_before_the_window_and_are_still_repeating_are_not_a_spike()
    {
        await using var host = await TestHost.CreateAsync();
        await AddFaultsAsync(host, 10, T0.AddMinutes(-1), firstSeen: T0.AddDays(-7));

        for (var i = 0; i < 8; i++) await SweepAsync(host, T0.AddMinutes(15 * i));
        Assert.Empty(await RowsAsync(host, AdminEventCatalogue.FaultSpike));

        await AddFaultsAsync(host, AdminNotificationSettings.DefaultFaultSpikeCount, T0.AddMinutes(104), firstSeen: T0.AddMinutes(104));
        await SweepAsync(host, T0.AddMinutes(105));
        var row = Assert.Single(await RowsAsync(host, AdminEventCatalogue.FaultSpike));
        Assert.Equal(AdminNotificationSettings.DefaultFaultSpikeCount,
            JsonSerializer.Deserialize<FaultSpikePayload>(row.PayloadJson, AdminEventCatalogue.Json)!.Faults);
    }

    private static async Task<Device> AddGateAsync(TestHost host, bool acknowledged)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var gate = new Device
        {
            TenantId = host.Tenant.Id, DeviceCode = $"gate-{Guid.NewGuid():N}"[..12], Name = "Front door",
            MacAddress = Guid.NewGuid().ToString("N")[..12], Kind = DeviceKind.Gate, GateKey = "front-door",
            AutoRegistered = !acknowledged, LastSeenAt = T0,
        };
        db.Devices.Add(gate);
        await db.SaveChangesAsync();
        return gate;
    }

    private static async Task AddRefusalsAsync(TestHost host, Device gate, int count, DateTimeOffset at)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        for (var i = 0; i < count; i++)
        {
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = host.Tenant.Id, Action = $"{DoorTrail.DeniedPrefix}no_booking",
                DetailsJson = JsonSerializer.Serialize(new { device_id = gate.Id }), CreatedAt = at.AddSeconds(i),
            });
        }
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// The doors tile's own rule, over the club's own two numbers — so the mail and the flag agree.
    /// Pinned two minutes into a spike bucket: at the wall clock, the second sweep thirty seconds
    /// on crossed a bucket boundary whenever the run started in the last half-minute of one, and
    /// the "one spike" was two (memory/gotchas-clock.md).
    /// </summary>
    [Fact]
    public async Task A_door_refusing_more_than_the_clubs_threshold_raises_one_spike_naming_no_member()
    {
        await using var host = await TestHost.CreateAsync();
        var minutes = DoorSettings.DefaultRefusalSpikeMinutes;
        var now = DateTimeOffset.FromUnixTimeSeconds(AdminNotificationSweep.Bucket(T0, minutes) * minutes * 60L).AddMinutes(2);
        var gate = await AddGateAsync(host, acknowledged: true);
        await AddRefusalsAsync(host, gate, DoorSettings.DefaultRefusalSpikeCount - 1, now.AddMinutes(-5));

        await SweepAsync(host, now);
        Assert.Empty(await RowsAsync(host, AdminEventCatalogue.RefusalSpike));

        await AddRefusalsAsync(host, gate, 1, now.AddMinutes(-1));
        await SweepAsync(host, now);
        await SweepAsync(host, now.AddSeconds(30));

        var row = Assert.Single(await RowsAsync(host, AdminEventCatalogue.RefusalSpike));
        Assert.Equal($"/admin/monitoring/doors/{gate.Id}", row.Link);
        await host.DeliverAdminNoticesAsync(now.AddMinutes(1));
        var mail = Assert.Single(host.EmailService.Sent);
        Assert.Equal("Front door is turning people away", mail.Subject);
        Assert.DoesNotContain(host.PlayerUser.Email, mail.HtmlBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_door_no_admin_has_acknowledged_raises_no_spike()
    {
        await using var host = await TestHost.CreateAsync();
        var gate = await AddGateAsync(host, acknowledged: false);
        await AddRefusalsAsync(host, gate, 40, T0.AddMinutes(-2));

        await SweepAsync(host, T0);

        Assert.Empty(await RowsAsync(host, AdminEventCatalogue.RefusalSpike));
    }

    [Fact]
    public async Task Finished_notices_past_the_clubs_retention_are_deleted_and_pending_ones_never()
    {
        await using var host = await TestHost.CreateAsync();
        var ancient = T0.AddDays(-(AdminNotificationSettings.DefaultRetentionDays + 1));
        var sent = await StageAsync(host, Registration("Old Sent"), ancient);
        await host.DeliverAdminNoticesAsync(ancient);
        host.EmailService.FailWhen = _ => true;
        var stuck = await StageAsync(host, Registration("Old Stuck"), ancient);
        await host.DeliverAdminNoticesAsync(ancient);
        var recent = await StageAsync(host, Registration("Recent"), T0.AddDays(-1));

        await SweepAsync(host, T0);

        using var scope = host.NewScope();
        var ids = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>()
            .AdminNotifications.IgnoreQueryFilters().Select(n => n.Id).ToListAsync();
        Assert.DoesNotContain(sent, ids);
        Assert.Contains(stuck, ids);
        Assert.Contains(recent, ids);
    }

    private static async Task PatchSettingsAsync(TestHost host, params (string Key, int Value)[] values)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(t => t.TenantId == host.Tenant.Id);
        var json = JsonNode.Parse(row.SettingsJson)!.AsObject();
        foreach (var (key, value) in values) json[key] = value;
        row.SettingsJson = json.ToJsonString();
        await db.SaveChangesAsync();
    }

    private static async Task<List<Guid>> AllIdsAsync(TestHost host)
    {
        using var scope = host.NewScope();
        return await scope.ServiceProvider.GetRequiredService<MainframeDbContext>()
            .AdminNotifications.IgnoreQueryFilters().Select(n => n.Id).ToListAsync();
    }

    /// <summary>
    /// Review (retention): a notice carries names, addresses and balances, and must not outlast
    /// the club's own <c>retention_years</c> however long the feed setting is.
    /// </summary>
    [Fact]
    public async Task A_notice_is_never_kept_past_the_clubs_retention_years()
    {
        await using var host = await TestHost.CreateAsync();
        await PatchSettingsAsync(host, ("retention_years", 1), ("admin_notification_retention_days", AdminNotificationSettings.MaxRetentionDays));
        var tooOld = await StageAsync(host, Registration("Past a Year"), T0.AddDays(-400));
        var kept = await StageAsync(host, Registration("Inside a Year"), T0.AddDays(-300));
        await host.DeliverAdminNoticesAsync(T0.AddDays(-300));

        await SweepAsync(host, T0);

        var ids = await AllIdsAsync(host);
        Assert.DoesNotContain(tooOld, ids);
        Assert.Contains(kept, ids);
    }

    /// <summary>
    /// Review F3: a schedule clash's row is the only thing stopping the sweep raising the same
    /// standing clash again, so a short retention must not delete it while its first clash is
    /// still ahead. Past the horizon plus a day its night is behind us and it goes like any other.
    /// </summary>
    [Fact]
    public async Task A_schedule_clash_outlives_a_short_retention_until_its_night_has_passed()
    {
        await using var host = await TestHost.CreateAsync();
        await PatchSettingsAsync(host, ("admin_notification_retention_days", AdminNotificationSettings.MinRetentionDays));
        var schedule = new BookingSchedule { TenantId = host.Tenant.Id, Name = "League night", Label = "League" };
        var clash = AdminNotices.ScheduleConflict(schedule, [DateOnly.FromDateTime(T0.AddDays(50).UtcDateTime)], 1);
        var eightDaysAgo = T0.AddDays(-(AdminNotificationSettings.MinRetentionDays + 1));
        var standing = await StageAsync(host, clash, eightDaysAgo);
        var registration = await StageAsync(host, Registration("Short Retention"), eightDaysAgo);
        var horizon = ScheduleSettings.DefaultMaterialisationDays;
        var passed = await StageAsync(host,
            AdminNotices.ScheduleConflict(schedule, [DateOnly.FromDateTime(T0.AddDays(-2).UtcDateTime)], 1), T0.AddDays(-(horizon + 2)));
        await host.DeliverAdminNoticesAsync(eightDaysAgo);

        await SweepAsync(host, T0);

        var ids = await AllIdsAsync(host);
        Assert.Contains(standing, ids);
        Assert.DoesNotContain(registration, ids);
        Assert.DoesNotContain(passed, ids);

        // And the standing clash is still deduplicated: raising it again is "already raised".
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.False(await AdminNotices.RaiseAsync(db, host.Tenant.Id, clash, T0, default));
    }

    // ------------------------------------------------------------------ review fixes: delivery

    /// <summary>
    /// Review (cooldown): a notice that reached one admin and is retrying another holds the
    /// cooldown. Counting only finished rows let every sibling through while it waited — three
    /// overdraft mails inside one fifteen-minute window to the admin whose mailbox worked.
    /// </summary>
    [Fact]
    public async Task A_notice_that_reached_some_admins_holds_the_cooldown_while_it_retries_the_rest()
    {
        await using var host = await TestHost.CreateAsync();
        var working = await AddPersonAsync(host, "working.admin", isAdmin: true);
        var flaky = await AddPersonAsync(host, "flaky.admin", isAdmin: true);
        host.EmailService.FailWhen = m => m.To == flaky.Email;

        var first = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 1"), T0);
        await host.DeliverAdminNoticesAsync(T0);
        var second = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 2"), T0.AddMinutes(2));
        await host.DeliverAdminNoticesAsync(T0.AddMinutes(2));
        var third = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 3"), T0.AddMinutes(4));
        await host.DeliverAdminNoticesAsync(T0.AddMinutes(4));

        Assert.Single(host.EmailService.Sent, m => m.To == working.Email);
        Assert.Equal(AdminNotificationState.Suppressed, (await RowAsync(host, second)).State);
        Assert.Equal(AdminNotificationState.Suppressed, (await RowAsync(host, third)).State);

        // The retry is still owed to the admin it missed, and only that one.
        host.EmailService.FailWhen = null;
        await host.DeliverAdminNoticesAsync(T0.AddHours(1));
        Assert.Single(host.EmailService.Sent, m => m.To == working.Email);
        Assert.Single(host.EmailService.Sent, m => m.To == flaky.Email);
        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, first)).State);
    }

    /// <summary>
    /// The other side of the window: a notice that reached nobody, retried after a later sibling
    /// of the same scope was mailed, is withheld rather than making a second mail inside it.
    /// </summary>
    [Fact]
    public async Task A_notice_retried_after_a_later_sibling_was_mailed_is_withheld()
    {
        await using var host = await TestHost.CreateAsync();
        var colleague = await AddPersonAsync(host, "colleague.admin", isAdmin: true);
        host.EmailService.FailWhen = _ => true;
        var early = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 1"), T0);
        await host.DeliverAdminNoticesAsync(T0);
        Assert.Equal(0, (await RowAsync(host, early)).RecipientCount);

        host.EmailService.FailWhen = null;
        var later = await StageAsync(host, Overdraft(host.AdminUser.Id, host.PlayerUser.Id, "Court 2"), T0.AddSeconds(30));
        await host.DeliverAdminNoticesAsync(T0.AddSeconds(30));
        await host.DeliverAdminNoticesAsync(T0.AddMinutes(2));

        Assert.Single(host.EmailService.Sent, m => m.To == colleague.Email);
        Assert.Equal(AdminNotificationState.Sent, (await RowAsync(host, later)).State);
        Assert.Equal(AdminNotificationState.Suppressed, (await RowAsync(host, early)).State);
    }

    /// <summary>
    /// Review (hardening): a row claimed more times than the backoff allows — a pass that threw
    /// outside the send, so the backoff never judged it — is given up on, not claimed for ever.
    /// </summary>
    [Fact]
    public async Task A_row_claimed_past_the_attempt_limit_is_given_up_without_mailing()
    {
        await using var host = await TestHost.CreateAsync();
        var id = await StageAsync(host, Registration("Never Finished"));
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.AdminNotifications.IgnoreQueryFilters().SingleAsync(n => n.Id == id);
            row.Attempts = AdminNotificationDispatcher.MaxAttempts;
            await db.SaveChangesAsync();
        }

        await host.DeliverAdminNoticesAsync(T0);

        Assert.Empty(host.EmailService.Sent);
        var after = await RowAsync(host, id);
        Assert.Equal(AdminNotificationState.Failed, after.State);
        Assert.Equal("attempts_exhausted", after.LastError);
    }

    /// <summary>
    /// Review (header injection): a name with a line break in it reached the subject, which
    /// <c>MailMessage</c> refuses — the notice could never be sent. The subject is one line.
    /// </summary>
    [Fact]
    public async Task A_name_with_a_line_break_still_makes_a_sendable_one_line_subject()
    {
        await using var host = await TestHost.CreateAsync();
        var colleague = await AddPersonAsync(host, "colleague.admin", isAdmin: true);
        await StageAsync(host, AdminNotices.OverdraftAuthorised(Guid.NewGuid(), host.AdminUser.Id, host.PlayerUser.Id, new OverdraftPayload(
            Guid.NewGuid(), "Desk Admin", "Mo\r\nBcc: someone@elsewhere.review.test", Self: false, "Court 1", "Tue 29 Sep, 18:00", 24, -16)));

        await host.DeliverAdminNoticesAsync(T0);

        var mail = Assert.Single(host.EmailService.Sent, m => m.To == colleague.Email);
        Assert.Equal("Desk Admin took Mo Bcc: someone@elsewhere.review.test below zero", mail.Subject);
        using var message = new System.Net.Mail.MailMessage { Subject = mail.Subject };
        Assert.Equal(mail.Subject, message.Subject);
    }

    /// <summary>
    /// Review F2: the admin mail for a top-up says what actually happened to the member. A payment
    /// the gateway reported with no reference is a member who HAS PAID and has been told nothing;
    /// a checkout the gateway refused took no money and was not mailed.
    /// </summary>
    [Theory]
    [InlineData("payment_id_missing", "has not been told anything")]
    [InlineData("provider_register_failed", "was not emailed")]
    [InlineData("signature_invalid", "the notification was ignored")]
    [InlineData("amount_mismatch", "The member has been emailed that their purchase did not complete.")]
    [InlineData("gateway_error", "The member has been emailed that their purchase did not complete.")]
    public void The_top_up_mail_says_what_happened_to_the_member_for_each_reason(string reason, string expected)
    {
        var message = Crusaders.Mainframe.Api.Email.EmailTemplates.AdminTopUpFailed(
            EmailCatalogue.Riverside, "desk@riverside.review.test",
            new Crusaders.Mainframe.Api.Email.TopUpFailure(reason, 100, "Naledi Khoza", "ref", "R", "https://riverside.review.test/admin/transactions"));

        Assert.Contains(expected, MailText.Unwrap(message.PlainBody), StringComparison.Ordinal);
        if (reason is "payment_id_missing" or "provider_register_failed" or "signature_invalid")
        {
            Assert.DoesNotContain("has been emailed", MailText.Unwrap(message.PlainBody), StringComparison.Ordinal);
        }
        Assert.DoesNotContain("credit", MailText.Unwrap(message.PlainBody), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// P13 (contract §5, §12.2): the kind keeps its stored code <c>topup.failed</c> — admins'
    /// opt-outs and the outbox dedupe keys name it — while its words become a package purchase,
    /// and the notice raised from a purchase row carries the package and its minutes all the way
    /// to the admin's mail. A notice with no purchase behind it (a forged notification) names none.
    /// </summary>
    [Fact]
    public async Task A_failed_purchase_notice_keeps_its_code_and_names_the_package()
    {
        Assert.Equal("topup.failed", AdminEventCatalogue.TopUpFailed);
        var kind = AdminEventCatalogue.Find("topup.failed")!;
        Assert.Equal("Package purchases that need looking at", kind.Title);
        Assert.True(kind.OptOutable);

        var pending = new PendingTopup
        {
            Id = Guid.NewGuid(), UserId = Guid.NewGuid(), AmountZar = 495m, IdempotencyKey = "idem-1",
            ExternalReference = "pf-77", PackageName = "5 hours", Minutes = 300,
        };
        var notice = AdminNotices.TopUpFailed("amount_mismatch", pending.Id.ToString("N"), "Naledi Khoza", pending);
        Assert.Equal("topup.failed", notice.Kind);
        Assert.StartsWith("topup.failed:amount_mismatch:", notice.DedupeKey, StringComparison.Ordinal);
        Assert.Equal("Package purchase problem — amount mismatch (Naledi Khoza)", notice.Headline);
        var payload = Assert.IsType<TopUpFailedPayload>(notice.Payload);
        Assert.Equal(("5 hours", 300, 495m, "pf-77"), (payload.PackageName, payload.Minutes, payload.AmountZar, payload.Reference));

        await using var host = await TestHost.CreateAsync();
        var colleague = await AddPersonAsync(host, "purchases.admin", isAdmin: true);
        await StageAsync(host, notice);
        await host.DeliverAdminNoticesAsync(T0);

        var mail = Assert.Single(host.EmailService.Sent, m => m.To == colleague.Email);
        var text = MailText.Unwrap(mail.PlainBody);
        Assert.Equal("A package purchase needs looking at", mail.Subject);
        Assert.Contains("Package: 5 hours (5 hours)", text, StringComparison.Ordinal);
        Assert.Contains("R495.00", text, StringComparison.Ordinal);
        Assert.DoesNotContain("R300", text, StringComparison.Ordinal);

        // A forged notification has no purchase row, and so no package line.
        var forged = AdminNotices.TopUpFailed("signature_invalid", "20261001", null, null);
        var forgedPayload = Assert.IsType<TopUpFailedPayload>(forged.Payload);
        Assert.Null(forgedPayload.PackageName);
        Assert.Null(forgedPayload.AmountZar);
    }

    /// <summary>
    /// Review F4: a stored opt-out of a kind nobody may opt out of is not read back as one, so a
    /// settings screen that saves what it read is not refused.
    /// </summary>
    [Fact]
    public void A_stored_opt_out_of_a_non_optional_kind_is_not_read_back()
    {
        var view = UserPreferencesView.From(new UserPreferences
        {
            AdminNotificationOptoutsJson = JsonSerializer.Serialize(new[] { AdminEventCatalogue.AdminRoleChanged, AdminEventCatalogue.DeviceOffline }),
        });

        Assert.Equal(new[] { AdminEventCatalogue.DeviceOffline }, view.AdminNotificationOptouts);
    }

    /// <summary>Review (cursor): a well-formed number that is not an instant is a bad cursor, not a crash.</summary>
    [Theory]
    [InlineData("-1")]
    [InlineData("9223372036854775807")]
    public void A_cursor_whose_ticks_are_not_an_instant_is_refused(string ticks)
    {
        var raw = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{ticks}:{Guid.NewGuid():N}"));
        Assert.Null(Crusaders.Mainframe.Api.Endpoints.AdminChangeCursor.Parse(raw));
    }

    // ------------------------------------------------------------------ the catalogue

    /// <summary>
    /// Every kind is well-formed, unique, composes a message from a representative payload, and
    /// is one an admin's opt-out list could name. Security kinds are the non-optional ones.
    /// </summary>
    [Fact]
    public void Every_kind_in_the_catalogue_composes_and_the_security_ones_are_not_optional()
    {
        var samples = new Dictionary<string, object>
        {
            [AdminEventCatalogue.MemberRegistered] = new RegistrationPayload(Guid.NewGuid(), "A", "a@x.review.test", "N-1"),
            [AdminEventCatalogue.ApplicationsPending] = new ApplicationsPendingPayload(2, "A", 30),
            [AdminEventCatalogue.DeviceOffline] = new DeviceOutagePayload(Guid.NewGuid(), false, "Box", "box-1", null, [1], 12),
            [AdminEventCatalogue.DeviceRecovered] = new DeviceOutagePayload(Guid.NewGuid(), true, "Door", "gate-1", "front", [], 12),
            [AdminEventCatalogue.FaultSpike] = new FaultSpikePayload(5, 15, ["box-1"]),
            [AdminEventCatalogue.RefusalSpike] = new RefusalSpikePayload(Guid.NewGuid(), "Door", "gate-1", "front", 9, 20),
            [AdminEventCatalogue.TopUpFailed] = new TopUpFailedPayload("gateway_error", 100, "A", "ref"),
            [AdminEventCatalogue.WebhookAutoDisabled] = new WebhookDisabledPayload(Guid.NewGuid(), "https://h.review.test", null, 6, false),
            [AdminEventCatalogue.ScheduleConflict] = new ScheduleConflictPayload(Guid.NewGuid(), "League", "2026-10-06", 1, ["2026-10-06"]),
            [AdminEventCatalogue.OverdraftAuthorised] = new OverdraftPayload(Guid.NewGuid(), "A", "B", false, "Court 1", "Tue", 8, -8),
            [AdminEventCatalogue.AdminRoleChanged] = new AdminRolePayload("A", "B", true, null),
            [AdminEventCatalogue.CodeForgerySuspected] = new ForgeryPayload("box-1", null, "detail"),
            [AdminEventCatalogue.CodesCapabilityLost] = new CodesCapabilityLostPayload(Guid.NewGuid(), "Box", "box-1", "2.0.0", "v1"),
            [AdminEventCatalogue.MemberDeleted] = new MemberDeletedPayload("A", "B", "moved away", true, 1, 30),
        };

        Assert.Equal(AdminEventCatalogue.All.Count, AdminEventCatalogue.All.Select(k => k.Kind).Distinct().Count());
        Assert.Equal(samples.Keys.OrderBy(k => k), AdminEventCatalogue.All.Select(k => k.Kind).OrderBy(k => k));

        foreach (var kind in AdminEventCatalogue.All)
        {
            var (kinds, error) = UserPreferencesRules.NormaliseOptouts([kind.Kind]);
            Assert.Null(error);
            Assert.Equal(kind.Kind, Assert.Single(kinds!));

            var row = new AdminNotification
            {
                Kind = kind.Kind, DedupeKey = "k", Headline = "h", Link = "/admin",
                PayloadJson = JsonSerializer.Serialize(samples[kind.Kind], samples[kind.Kind].GetType(), AdminEventCatalogue.Json),
            };
            foreach (var toSubject in new[] { false, true })
            {
                var message = AdminEventCatalogue.Compose(new AdminMailContext(
                    EmailCatalogue.Riverside, "desk@riverside.review.test", row, toSubject, "https://riverside.review.test",
                    new TenantSettingsView(15, 30, 5, 15, 14, "UTC", 60, "16:00-19:00", 1, 2, 0, 1440, 7, ButtonMap.Default())));
                Assert.Contains("Riverside Racquet Club", message.HtmlBody, StringComparison.Ordinal);
            }
        }

        Assert.Equal(
            new[] { AdminEventCatalogue.AdminRoleChanged, AdminEventCatalogue.CodeForgerySuspected, AdminEventCatalogue.WebhookAutoDisabled },
            AdminEventCatalogue.All.Where(k => !k.OptOutable).Select(k => k.Kind).OrderBy(k => k, StringComparer.Ordinal));
    }
}
