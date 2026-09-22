using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>Admins:Emails</c> — the deployment's inherent administrators.
///
/// <para>
/// Two things are being pinned here and they pull in opposite directions. The feature must
/// actually confer club-admin rights on a configured address wherever that person already holds
/// an account, including one registered long after the stack was deployed. And it must confer
/// <b>nothing else</b>: not a password, not a verified address, not a club's approval, and not a
/// single row in a club the person has never joined. A test file that proves only the first half
/// is how a configuration key becomes an authentication bypass.
/// </para>
/// </summary>
public class InherentAdminTests
{
    private const string Founder = "dean.martin@frostaura.net";

    private static InherentAdmins Parse(params string[] entries)
    {
        var values = new Dictionary<string, string?>();
        for (var i = 0; i < entries.Length; i++) values[$"{InherentAdmins.SectionKey}:{i}"] = entries[i];
        return InherentAdmins.From(new ConfigurationBuilder().AddInMemoryCollection(values).Build());
    }

    private static InherentAdminService ServiceFor(TestHost host, IServiceScope scope, CapturingLogger log) =>
        new(scope.ServiceProvider.GetRequiredService<MainframeDbContext>(),
            host.Services.GetRequiredService<InherentAdmins>(),
            log.As<InherentAdminService>());

    private static async Task<int> PromotionRowsAsync(MainframeDbContext db, Guid userId) =>
        await db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.SubjectUserId == userId && a.Action == InherentAdminService.PromotionAction);

    // ---- Reading the configuration ----

    [Fact]
    public void Addresses_are_trimmed_lowercased_and_deduplicated()
    {
        // The three shapes an operator actually produces: a copied line with trailing space, a
        // mail client's capitalisation, and the same person listed twice after an edit.
        var admins = Parse("  Dean.Martin@FrostAura.net  ", "dean.martin@frostaura.net", "chair@club.example");

        Assert.Equal(2, admins.Emails.Count);
        Assert.Contains(Founder, admins.Emails);
        Assert.Contains("chair@club.example", admins.Emails);
        // And the comparison a sign-in makes has to agree with the stored form, which
        // AuthService has lower-cased since long before this feature existed.
        Assert.True(admins.Includes("DEAN.MARTIN@frostaura.net "));
    }

    [Fact]
    public void Blank_and_malformed_entries_are_ignored_and_the_startup_log_names_them()
    {
        var log = new CapturingLogger();

        var admins = Parse("", "   ", "not-an-email", "@nobody", "two@at@signs", "has space@club.example", Founder);
        admins.Report(log.As<InherentAdmins>());

        Assert.Equal(new[] { Founder }, admins.Emails);
        var warning = Assert.Single(log.Entries, e => e.Level == LogLevel.Warning);
        foreach (var bad in new[] { "not-an-email", "@nobody", "two@at@signs", "has space@club.example" })
        {
            Assert.Contains(bad, warning.Message);
        }
    }

    /// <summary>
    /// The accepted list is a roster of the people who can administer every club on this
    /// deployment. Information is the level a container log actually keeps, and these logs are
    /// read by whoever can see the Portainer stack — so the count goes there and the addresses
    /// do not. What was IGNORED is different: an operator cannot fix a typo they cannot see.
    /// </summary>
    [Fact]
    public void The_accepted_list_is_never_written_to_the_log_at_information()
    {
        var log = new CapturingLogger();

        Parse(Founder, "chair@club.example").Report(log.As<InherentAdmins>());

        Assert.Contains(log.Entries, e => e.Level == LogLevel.Information);
        Assert.DoesNotContain(log.Entries,
            e => e.Level >= LogLevel.Information && e.Message.Contains(Founder, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(log.Entries, e => e.Level == LogLevel.Information && e.Message.Contains('2'));
    }

    [Fact]
    public void An_absent_section_is_an_empty_list_and_is_not_an_error()
    {
        var log = new CapturingLogger();

        var admins = InherentAdmins.From(new ConfigurationBuilder().Build());
        admins.Report(log.As<InherentAdmins>());

        Assert.Empty(admins.Emails);
        Assert.False(admins.Includes(Founder));
        // An empty array in production is an ordinary configuration, not a misconfiguration.
        Assert.DoesNotContain(log.Entries, e => e.Level >= LogLevel.Warning);
    }

    // ---- What a sign-in does ----

    [Fact]
    public async Task An_inherent_admin_is_promoted_at_sign_in_and_the_promotion_is_audited()
    {
        await using var host = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        await SeedMemberAsync(host, Founder, "Member!Pass1");

        var result = await SignInAsync(host, Founder, "Member!Pass1");

        var ok = Assert.IsType<LoginResult.Ok>(result);
        Assert.True(ok.IsAdmin);
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Email == Founder);
        Assert.True(user.IsAdmin);
        var row = await db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.SubjectUserId == user.Id && a.Action == InherentAdminService.PromotionAction);
        Assert.Equal(host.Tenant.Id, row.TenantId);
        // The trail has to say WHERE the rights came from. "An admin made them an admin" is the
        // one reading that is not true of this row.
        Assert.Contains(InherentAdmins.SectionKey, row.DetailsJson);
    }

    /// <summary>
    /// A promotion is an event; being an admin is not. Writing a row — or a log line — every
    /// time a configured address signs in turns the audit trail into a heartbeat.
    /// </summary>
    [Fact]
    public async Task A_promotion_happens_once_and_every_later_sign_in_writes_nothing()
    {
        await using var host = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        await SeedMemberAsync(host, Founder, "Member!Pass1");

        await SignInAsync(host, Founder, "Member!Pass1");
        await SignInAsync(host, Founder, "Member!Pass1");
        await SignInAsync(host, Founder, "Member!Pass1");

        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Email == Founder);
        Assert.Equal(1, await PromotionRowsAsync(db, user.Id));
    }

    [Fact]
    public async Task An_empty_list_leaves_a_sign_in_exactly_as_it_was()
    {
        await using var host = await TestHost.CreateAsync();
        await SeedMemberAsync(host, Founder, "Member!Pass1");

        var ok = Assert.IsType<LoginResult.Ok>(await SignInAsync(host, Founder, "Member!Pass1"));

        Assert.False(ok.IsAdmin);
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Email == Founder);
        Assert.False(user.IsAdmin);
        Assert.Equal(0, await PromotionRowsAsync(db, user.Id));
    }

    // ---- Removal from the list ----

    /// <summary>
    /// <b>A config edit must not be able to lock a club out of its own admin console.</b>
    ///
    /// <para>
    /// Removing an address — a rename, a typo, an <c>Admins__Emails__0</c> that a redeploy
    /// dropped — would otherwise strip the flag from a live administrator at their next sign-in,
    /// and if they were the club's only one there is no way back that does not involve editing
    /// the database. So the flag is kept. It is the same call
    /// <c>ProductionBootstrap.EnsureAdminAsync</c> makes about an existing admin, for the same
    /// reason, and it is made visible the same way: a warning naming the account, telling the
    /// operator where the flag is actually removed.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Removing_an_address_from_the_list_never_strips_a_live_admin()
    {
        await using var promoting = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        await SeedMemberAsync(promoting, Founder, "Member!Pass1");
        await SignInAsync(promoting, Founder, "Member!Pass1");

        // The same club, the same rows, the address gone from the configuration.
        var log = new CapturingLogger();
        using var scope = promoting.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Email == Founder);
        await using var reduced = await TestHost.CreateAsync(inherentAdminEmails: new[] { "chair@club.example" });
        var service = ServiceFor(reduced, scope, log);

        await service.ApplyAsync(user, CancellationToken.None);
        await db.SaveChangesAsync();

        Assert.True(user.IsAdmin);
        Assert.Equal(1, await PromotionRowsAsync(db, user.Id));
        var warning = Assert.Single(log.Entries, e => e.Level == LogLevel.Warning);
        Assert.Contains(Founder, warning.Message);
        Assert.Contains(InherentAdmins.SectionKey, warning.Message);
    }

    /// <summary>
    /// The warning above is about an inherited flag that no longer has a configuration behind
    /// it. An admin the club appointed from Admin → Members has nothing to do with this list,
    /// and warning about them on every sign-in would train the operator to ignore the message
    /// that matters.
    /// </summary>
    [Fact]
    public async Task An_admin_the_club_appointed_itself_is_never_reported_as_a_stale_inherent_admin()
    {
        await using var host = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        var log = new CapturingLogger();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var clubAdmin = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Id == host.AdminUser.Id);

        await ServiceFor(host, scope, log).ApplyAsync(clubAdmin, CancellationToken.None);

        Assert.True(clubAdmin.IsAdmin);
        Assert.DoesNotContain(log.Entries, e => e.Level >= LogLevel.Warning);
        Assert.Equal(0, await PromotionRowsAsync(db, clubAdmin.Id));
    }

    // ---- Not an authentication bypass ----

    [Fact]
    public async Task Being_on_the_list_does_not_admit_a_wrong_password()
    {
        await using var host = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        await SeedMemberAsync(host, Founder, "Member!Pass1");

        var result = await SignInAsync(host, Founder, "not-the-password");

        Assert.IsType<LoginResult.InvalidCredentials>(result);
        await AssertNotPromotedAsync(host, Founder);
    }

    [Fact]
    public async Task Being_on_the_list_does_not_skip_email_verification()
    {
        await using var host = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        await SeedMemberAsync(host, Founder, "Member!Pass1", emailVerified: false);

        var result = await SignInAsync(host, Founder, "Member!Pass1");

        Assert.IsType<LoginResult.EmailNotVerified>(result);
        await AssertNotPromotedAsync(host, Founder);
    }

    [Theory]
    [InlineData(MembershipStatus.PendingApproval)]
    [InlineData(MembershipStatus.Suspended)]
    [InlineData(MembershipStatus.Rejected)]
    public async Task Being_on_the_list_does_not_admit_a_member_the_club_has_not_approved(MembershipStatus status)
    {
        await using var host = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        await SeedMemberAsync(host, Founder, "Member!Pass1", status: status);

        var result = await SignInAsync(host, Founder, "Member!Pass1");

        Assert.IsType<LoginResult.NotApproved>(result);
        // And — the part that makes the refusal durable — the account did not quietly become an
        // admin on the way out, which would have admitted it on the NEXT attempt: IsAdmin is
        // what exempts an account from this very check.
        await AssertNotPromotedAsync(host, Founder);
    }

    /// <summary>
    /// Registration deliberately does not promote, and this is the test that says so out loud.
    /// A registering applicant is unverified and unapproved; handing them <c>IsAdmin</c> there
    /// would exempt them from both checks at their first sign-in. They get the flag at the first
    /// sign-in that passes everything — which is the earliest moment it changes nothing else.
    /// </summary>
    [Fact]
    public async Task An_inherent_admin_who_registers_later_gets_it_at_their_first_clean_sign_in_and_not_before()
    {
        await using var host = await TestHost.CreateAsync(inherentAdminEmails: new[] { Founder });
        using (var scope = host.NewScope())
        {
            var auth = scope.ServiceProvider.GetRequiredService<AuthService>();
            var created = await auth.RegisterAsync(
                Founder, "Member!Pass1", "Dean Martin", "NEW-0001", null, CancellationToken.None);
            Assert.IsType<RegistrationResult.Created>(created);
        }

        await AssertNotPromotedAsync(host, Founder);

        // The club verifies the address and approves the application; nothing else changes.
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var user = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Email == Founder);
            user.EmailVerified = true;
            var membership = await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.UserId == user.Id);
            membership.Status = MembershipStatus.Active;
            await db.SaveChangesAsync();
        }

        var ok = Assert.IsType<LoginResult.Ok>(await SignInAsync(host, Founder, "Member!Pass1"));
        Assert.True(ok.IsAdmin);
    }

    // ---- Multi-tenancy ----

    /// <summary>
    /// <b>The cross-tenant reading, decided and pinned.</b> An inherent admin is an admin in the
    /// clubs where they already hold a user row, and in no others. The alternative — admin
    /// everywhere — means inventing a <c>User</c> and a <c>Membership</c> in every club on the
    /// deployment: a person in a members list who never joined, holding a membership number the
    /// club did not issue, in a product whose booking grid shows members to each other.
    /// </summary>
    [Fact]
    public async Task An_inherent_admin_in_one_club_is_nothing_at_all_in_another()
    {
        var shared = $"inherent-{Guid.NewGuid():N}";
        await using var clubA = await TestHost.CreateAsync("club-a", shared, new[] { Founder });
        await using var clubB = await TestHost.CreateAsync("club-b", shared, new[] { Founder });
        await SeedMemberAsync(clubA, Founder, "Member!Pass1");
        var bBefore = await CountsAsync(clubB);

        var ok = Assert.IsType<LoginResult.Ok>(await SignInAsync(clubA, Founder, "Member!Pass1"));
        Assert.True(ok.IsAdmin);

        // Club B is in the SAME store — with a database per host this assertion would hold
        // with every query filter deleted.
        using var scope = clubB.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(bBefore, await CountsAsync(clubB));
        Assert.False(await db.Users.IgnoreQueryFilters()
            .AnyAsync(u => u.TenantId == clubB.Tenant.Id && u.Email == Founder));
        Assert.False(await db.AuditLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.TenantId == clubB.Tenant.Id && a.Action == InherentAdminService.PromotionAction));
        // And the admins club B has are the ones club B had.
        Assert.Equal(new[] { clubB.AdminUser.Id }, await db.Users.IgnoreQueryFilters()
            .Where(u => u.TenantId == clubB.Tenant.Id && u.IsAdmin).Select(u => u.Id).ToArrayAsync());
    }

    /// <summary>
    /// The other half of the same decision: the same human with an account at BOTH clubs is an
    /// admin at both — two rows, promoted independently, each in its own tenant.
    /// </summary>
    [Fact]
    public async Task The_same_person_with_an_account_at_two_clubs_is_promoted_in_each_one_separately()
    {
        var shared = $"inherent-{Guid.NewGuid():N}";
        await using var clubA = await TestHost.CreateAsync("club-a", shared, new[] { Founder });
        await using var clubB = await TestHost.CreateAsync("club-b", shared, new[] { Founder });
        await SeedMemberAsync(clubA, Founder, "Member!Pass1");
        await SeedMemberAsync(clubB, Founder, "Member!Pass2");

        await SignInAsync(clubA, Founder, "Member!Pass1");

        using var scope = clubA.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var inA = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.TenantId == clubA.Tenant.Id && u.Email == Founder);
        var inB = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.TenantId == clubB.Tenant.Id && u.Email == Founder);
        Assert.True(inA.IsAdmin);
        Assert.False(inB.IsAdmin);

        await SignInAsync(clubB, Founder, "Member!Pass2");

        using var after = clubB.NewScope();
        var db2 = after.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.True((await db2.Users.IgnoreQueryFilters().SingleAsync(u => u.Id == inB.Id)).IsAdmin);
        Assert.Equal(1, await PromotionRowsAsync(db2, inA.Id));
        Assert.Equal(1, await PromotionRowsAsync(db2, inB.Id));
    }

    // ---- The shipped defaults ----

    /// <summary>
    /// Both shipped <c>appsettings</c> files carry the founder, and they are read here rather
    /// than trusted: .NET configuration merges arrays <b>by index</b>, so the Development file's
    /// entry 0 REPLACES the base file's entry 0 rather than adding to it. A change that edits one
    /// file and not the other does not produce two entries, it produces a development environment
    /// quietly configured with somebody else — which is invisible until an admin screen is missing.
    /// </summary>
    [Theory]
    [InlineData("appsettings.json")]
    [InlineData("appsettings.Development.json")]
    public void Both_shipped_settings_files_carry_the_founder_as_an_inherent_admin(string file)
    {
        var path = Path.Combine(
            DeploymentPostureTests.RepoRoot(), "src", "backend", "Crusaders.Mainframe.Api", file);
        var config = new ConfigurationBuilder().AddJsonFile(path).Build();

        var admins = InherentAdmins.From(config);

        Assert.Contains(Founder, admins.Emails);
        Assert.Empty(admins.Ignored);
        // And the explanation sits beside the value, in this repo's commenting style, so the
        // next person to read the file learns what the list does without opening the source.
        Assert.Contains("_comment_Admins", File.ReadAllText(path), StringComparison.Ordinal);
    }

    // ---- Fixture helpers ----

    private static async Task<(int Users, int Memberships, int Audits)> CountsAsync(TestHost host)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return (
            await db.Users.IgnoreQueryFilters().CountAsync(u => u.TenantId == host.Tenant.Id),
            await db.Memberships.IgnoreQueryFilters().CountAsync(m => m.TenantId == host.Tenant.Id),
            await db.AuditLogs.IgnoreQueryFilters().CountAsync(a => a.TenantId == host.Tenant.Id));
    }

    private static async Task SeedMemberAsync(
        TestHost host, string email, string password, bool emailVerified = true,
        MembershipStatus status = MembershipStatus.Active)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<Api.Security.IPasswordHasher>();
        var user = new User
        {
            TenantId = host.Tenant.Id,
            Email = email,
            PasswordHash = hasher.Hash(password),
            EmailVerified = emailVerified,
            IsAdmin = false,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = host.Tenant.Id,
            UserId = user.Id,
            FullName = "Seeded Member",
            MembershipNumber = $"SEED-{Guid.NewGuid():N}"[..12],
            Status = status,
        });
        await db.SaveChangesAsync();
    }

    private static async Task<LoginResult> SignInAsync(TestHost host, string email, string password)
    {
        using var scope = host.NewScope();
        // The tenant this sign-in is happening at, set the way the middleware would. Without it
        // a shared-database fixture resolves whichever club's row it finds first.
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(host.Tenant.Id, host.Tenant.Slug);
        return await scope.ServiceProvider.GetRequiredService<AuthService>()
            .LoginAsync(email, password, CancellationToken.None);
    }

    private static async Task AssertNotPromotedAsync(TestHost host, string email)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = await db.Users.IgnoreQueryFilters()
            .SingleAsync(u => u.TenantId == host.Tenant.Id && u.Email == email);
        Assert.False(user.IsAdmin);
        Assert.Equal(0, await PromotionRowsAsync(db, user.Id));
    }
}

/// <summary>
/// An <see cref="ILogger"/> that keeps what it was told, so a test can assert on a log line the
/// way it asserts on a row. The level matters as much as the text here: what an operator must
/// see and what must never reach a container log are both claims about a level.
/// </summary>
public sealed class CapturingLogger : ILogger
{
    public sealed record Entry(LogLevel Level, string Message);

    private readonly List<Entry> _entries = new();

    public IReadOnlyList<Entry> Entries
    {
        get { lock (_entries) return _entries.ToList(); }
    }

    /// <summary>This logger wearing the generic interface a service's constructor asks for.</summary>
    public ILogger<T> As<T>() => new Typed<T>(this);

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        lock (_entries) _entries.Add(new Entry(logLevel, formatter(state, exception)));
    }

    private sealed class Typed<T>(CapturingLogger inner) : ILogger<T>
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => inner.BeginScope(state);

        public bool IsEnabled(LogLevel logLevel) => inner.IsEnabled(logLevel);

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            inner.Log(logLevel, eventId, state, exception, formatter);
    }
}
