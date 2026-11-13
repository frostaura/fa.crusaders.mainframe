using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Pins the behaviour of the first-run bootstrap.
///
/// <para>
/// These deliberately do NOT use <c>TestHost</c>, which seeds a tenant, an admin and four courts
/// before a test sees it. The entire subject here is what happens against a database with
/// nothing in it — the state a real production deployment starts in, and the state that took the
/// club's first deployment down. A fixture that pre-seeds the rows under test would pass with
/// the bootstrap deleted.
/// </para>
/// </summary>
public class ProductionBootstrapTests
{
    private static readonly Dictionary<string, string?> ValidConfig = new()
    {
        ["Bootstrap:Enabled"] = "true",
        ["Bootstrap:TenantSlug"] = "crusaders",
        ["Bootstrap:TenantDisplayName"] = "Crusaders Squash Club",
        ["Bootstrap:AdminEmail"] = "committee@crusaders.example",
        ["Bootstrap:AdminPassword"] = "a-real-bootstrap-password",
    };

    /// <summary>An empty container: schema, no rows.</summary>
    private static async Task<IServiceProvider> EmptyAsync()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        // Named ONCE, outside the options lambda. That lambda runs on every DbContext
        // construction, so a Guid computed inside it hands each scope its own empty database —
        // and every assertion about what the bootstrap wrote then reads an unrelated store.
        var dbName = $"bootstrap-{Guid.NewGuid():N}";
        services.AddDbContext<MainframeDbContext>(o => o.UseInMemoryDatabase(dbName));
        services.AddScoped<ITenantContext>(_ => new TenantContext());
        services.AddSingleton<IPasswordHasher, Pbkdf2PasswordHasher>();
        var sp = services.BuildServiceProvider();
        using var scope = sp.CreateScope();
        await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().Database.EnsureCreatedAsync();
        return sp;
    }

    private static IConfiguration Config(params (string Key, string? Value)[] overrides)
    {
        var values = new Dictionary<string, string?>(ValidConfig);
        foreach (var (key, value) in overrides)
        {
            if (value is null) values.Remove(key);
            else values[key] = value;
        }
        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private static Task RunAsync(IServiceProvider sp, IConfiguration config) =>
        ProductionBootstrap.RunAsync(sp, config, NullLogger.Instance);

    private static MainframeDbContext Db(IServiceProvider sp) =>
        sp.CreateScope().ServiceProvider.GetRequiredService<MainframeDbContext>();

    // ---- The blocker this type exists to remove ----

    [Fact]
    public async Task An_empty_production_database_gets_a_tenant_so_requests_stop_404ing()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config());

        var tenant = await Db(sp).Tenants.IgnoreQueryFilters().SingleAsync();
        Assert.Equal("crusaders", tenant.Slug);
        Assert.Equal("Crusaders Squash Club", tenant.DisplayName);
        Assert.Equal("active", tenant.Status);
    }

    [Fact]
    public async Task Nothing_happens_at_all_when_bootstrap_is_not_enabled()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config(("Bootstrap:Enabled", "false")));

        Assert.Empty(await Db(sp).Tenants.IgnoreQueryFilters().ToListAsync());
    }

    [Fact]
    public async Task A_disabled_bootstrap_does_not_validate_its_own_configuration()
    {
        // Otherwise every existing deployment that has never heard of these keys fails to boot
        // the moment this code ships.
        var sp = await EmptyAsync();

        await RunAsync(sp, Config(("Bootstrap:Enabled", "false"), ("Bootstrap:AdminPassword", null)));
    }

    // ---- Bootstrap:DeviceApiKey (device-api.md §6, BD-3, IO-01) ----

    /// <summary>A rebuilt stack puts back the key every board already holds, so a lost database is not a reflash.</summary>
    [Fact]
    public async Task A_rebuilt_stack_puts_back_the_device_key_the_boards_hold()
    {
        var sp = await EmptyAsync();
        var key = Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceApiKey.Generate();

        await RunAsync(sp, Config(("Bootstrap:DeviceApiKey", key)));

        Assert.Equal(key, (await Db(sp).Tenants.IgnoreQueryFilters().SingleAsync()).DeviceApiKey);
    }

    /// <summary>Never over a live key: a club that already has one keeps it (an owner restores from the console).</summary>
    [Fact]
    public async Task The_bootstrap_key_never_replaces_a_live_one()
    {
        var sp = await EmptyAsync();
        var first = Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceApiKey.Generate();
        await RunAsync(sp, Config(("Bootstrap:DeviceApiKey", first)));

        await RunAsync(sp, Config(("Bootstrap:DeviceApiKey", Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceApiKey.Generate())));

        Assert.Equal(first, (await Db(sp).Tenants.IgnoreQueryFilters().SingleAsync()).DeviceApiKey);
    }

    /// <summary>A value no board would accept refuses to start rather than being saved and refusing every board.</summary>
    [Fact]
    public async Task A_malformed_bootstrap_key_refuses_to_start()
    {
        var sp = await EmptyAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(sp, Config(("Bootstrap:DeviceApiKey", "not-a-43-character-key"))));
    }

    // ---- Idempotence ----

    [Fact]
    public async Task Running_on_every_boot_is_safe_and_creates_nothing_the_second_time()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config());
        await RunAsync(sp, Config());
        await RunAsync(sp, Config());

        var db = Db(sp);
        Assert.Single(await db.Tenants.IgnoreQueryFilters().ToListAsync());
        Assert.Single(await db.Users.IgnoreQueryFilters().ToListAsync());
        Assert.Equal(4, await db.Courts.IgnoreQueryFilters().CountAsync());
        Assert.Single(await db.TenantSettings.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// The development seeder re-stamps its hardcoded password onto the admin row on EVERY boot.
    /// Doing that here would silently revert the rotation the club performs at first sign-in and
    /// keep the compose file's password live for the life of the deployment.
    /// </summary>
    [Fact]
    public async Task An_admin_who_has_changed_their_password_keeps_it_across_a_reboot()
    {
        var sp = await EmptyAsync();
        await RunAsync(sp, Config());

        var hasher = sp.GetRequiredService<IPasswordHasher>();
        using (var scope = sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var admin = await db.Users.IgnoreQueryFilters().SingleAsync();
            admin.PasswordHash = hasher.Hash("the-password-the-club-actually-chose");
            admin.MustChangePassword = false;
            await db.SaveChangesAsync();
        }

        await RunAsync(sp, Config());

        var after = await Db(sp).Users.IgnoreQueryFilters().SingleAsync();
        Assert.True(hasher.Verify("the-password-the-club-actually-chose", after.PasswordHash!));
        Assert.False(hasher.Verify("a-real-bootstrap-password", after.PasswordHash!));
        Assert.False(after.MustChangePassword);
    }

    // ---- What it creates ----

    [Fact]
    public async Task The_bootstrap_admin_must_change_the_compose_files_password_at_first_sign_in()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config());

        var admin = await Db(sp).Users.IgnoreQueryFilters().SingleAsync();
        Assert.True(admin.MustChangePassword);
        Assert.True(admin.IsAdmin);
        Assert.True(admin.EmailVerified);
        Assert.Equal("committee@crusaders.example", admin.Email);
    }

    [Fact]
    public async Task An_admin_email_in_capitals_is_stored_lowercased_so_sign_in_matches()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config(("Bootstrap:AdminEmail", "Committee@Crusaders.Example")));

        Assert.Equal("committee@crusaders.example", (await Db(sp).Users.IgnoreQueryFilters().SingleAsync()).Email);
    }

    /// <summary>
    /// The court count comes from configuration, and courts carry no price (P13): a booking costs
    /// its own length in minutes. A <c>Bootstrap:SlicePriceCredits</c> left in an old compose file
    /// — even the 0 that used to stop the container — is ignored rather than refused.
    /// </summary>
    [Fact]
    public async Task The_court_count_comes_from_configuration_and_a_stale_slice_price_is_ignored()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config(("Bootstrap:Courts", "6"), ("Bootstrap:SlicePriceCredits", "0")));

        var courts = await Db(sp).Courts.IgnoreQueryFilters().OrderBy(c => c.CourtNumber).ToListAsync();
        Assert.Equal([1, 2, 3, 4, 5, 6], courts.Select(c => c.CourtNumber));
    }

    /// <summary>
    /// P13 §4.6: a new club's buy screen is never empty. The opening shelf is three club packages
    /// — 1 hour R120, 5 hours R550, 10 hours R1000 — written once, and never again: a second boot
    /// adds nothing, and a club whose admin has archived the lot keeps its own empty shelf.
    /// </summary>
    [Fact]
    public async Task A_new_club_gets_the_opening_shelf_once_and_never_over_its_own()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config());

        var shelf = await Db(sp).MinutePackages.IgnoreQueryFilters().OrderBy(p => p.SortOrder).ToListAsync();
        Assert.Equal(["1 hour", "5 hours", "10 hours"], shelf.Select(p => p.Name));
        Assert.Equal([60, 300, 600], shelf.Select(p => p.Minutes));
        Assert.Equal([120.00m, 550.00m, 1000.00m], shelf.Select(p => p.PriceZar));
        Assert.All(shelf, p => Assert.Null(p.GroupId));
        Assert.All(shelf, p => Assert.Equal(MinutePackageStatus.Active, p.Status));
        Assert.Null((await Db(sp).MemberGroups.IgnoreQueryFilters().SingleAsync(g => g.SystemKey == MemberGroupSystemKeys.League)).PackageDiscountBps);

        // The admin archives the whole shelf; the next boot must not put it back.
        using (var scope = sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            foreach (var p in await db.MinutePackages.IgnoreQueryFilters().ToListAsync()) p.Status = MinutePackageStatus.Archived;
            await db.SaveChangesAsync();
        }
        await RunAsync(sp, Config());

        var after = await Db(sp).MinutePackages.IgnoreQueryFilters().ToListAsync();
        Assert.Equal(3, after.Count);
        Assert.All(after, p => Assert.Equal(MinutePackageStatus.Archived, p.Status));
    }

    /// <summary>
    /// The development seeder writes five invented members with R500 opening balances and a
    /// fortnight of bookings. Against a real club that is fake people in the members list and
    /// fake money in the ledger — the reason this is a separate type rather than the seeder with
    /// its environment check removed.
    /// </summary>
    [Fact]
    public async Task No_sample_members_bookings_or_ledger_entries_reach_a_real_club()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config());

        var db = Db(sp);
        // The admin's own membership row is the only one, and no money has moved.
        Assert.Single(await db.Memberships.IgnoreQueryFilters().ToListAsync());
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().ToListAsync());
        Assert.Empty(await db.Bookings.IgnoreQueryFilters().ToListAsync());
    }

    [Fact]
    public async Task A_tenant_that_somehow_lost_its_settings_row_gets_one_back()
    {
        var sp = await EmptyAsync();
        using (var scope = sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Tenants.Add(new Api.Domain.Tenant { Slug = "crusaders", DisplayName = "Crusaders Squash Club" });
            await db.SaveChangesAsync();
        }

        await RunAsync(sp, Config());

        Assert.Single(await Db(sp).TenantSettings.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// The seeded settings document must not carry the dev seeder's
    /// "REPLACE_WITH_PAYFAST_MERCHANT_ID" placeholders: that hands a real club a payment
    /// configuration that looks present and cannot work.
    /// </summary>
    [Fact]
    public async Task The_initial_settings_document_carries_no_placeholder_payment_credentials()
    {
        var sp = await EmptyAsync();

        await RunAsync(sp, Config());

        var json = (await Db(sp).TenantSettings.IgnoreQueryFilters().SingleAsync()).SettingsJson;
        Assert.DoesNotContain("REPLACE_WITH", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("payfast", json, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Changing Bootstrap__AdminEmail on a club that is already up must not take the stack down.
    ///
    /// <para>
    /// The admin lookup is by email, so a corrected typo or a move to a shared committee
    /// mailbox found nothing and fell through to creating a SECOND admin — whose membership row
    /// carried the same hardcoded ADMIN-0001, colliding with the unique index on
    /// (TenantId, MembershipNumber). The exception escaped startup, so the container then failed
    /// to boot on every restart, and the only way back was to edit the database or remember the
    /// old address. Found by changing the address during manual testing.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Changing_the_admin_email_afterwards_does_not_crash_the_stack()
    {
        var sp = await EmptyAsync();
        await RunAsync(sp, Config());

        await RunAsync(sp, Config(("Bootstrap:AdminEmail", "someone.else@crusaders.example")));

        // The original admin is untouched and no second one was invented.
        var admins = await Db(sp).Users.IgnoreQueryFilters().Where(u => u.IsAdmin).ToListAsync();
        Assert.Single(admins);
        Assert.Equal("committee@crusaders.example", admins[0].Email);
        Assert.Single(await Db(sp).Memberships.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// Defence in depth behind the check above: even asked to create an admin into a tenant
    /// where ADMIN-0001 is already spoken for, the number must not collide.
    /// </summary>
    [Fact]
    public async Task An_admin_membership_number_is_chosen_rather_than_assumed()
    {
        var sp = await EmptyAsync();
        using (var scope = sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var tenant = new Api.Domain.Tenant { Slug = "crusaders", DisplayName = "Crusaders Squash Club" };
            db.Tenants.Add(tenant);
            // A non-admin member who happens to hold the number, and NO admin — so the
            // existing-admin guard does not fire and creation really is attempted.
            var user = new Api.Domain.User { TenantId = tenant.Id, Email = "member@crusaders.example", Status = "active" };
            db.Users.Add(user);
            db.Memberships.Add(new Api.Domain.Membership
            {
                TenantId = tenant.Id, UserId = user.Id, FullName = "Holder",
                MembershipNumber = "ADMIN-0001", Status = Api.Domain.MembershipStatus.Active,
            });
            await db.SaveChangesAsync();
        }

        await RunAsync(sp, Config());

        var db2 = Db(sp);
        var adminUser = await db2.Users.IgnoreQueryFilters().SingleAsync(u => u.IsAdmin);
        var adminMembership = await db2.Memberships.IgnoreQueryFilters().SingleAsync(m => m.UserId == adminUser.Id);
        Assert.Equal("ADMIN-0002", adminMembership.MembershipNumber);
    }

    // ---- Refusing to start ----

    [Theory]
    [InlineData("Bootstrap:AdminPassword", null, "AdminPassword")]
    [InlineData("Bootstrap:AdminPassword", "short", "at least 12")]
    [InlineData("Bootstrap:AdminPassword", "ChangeMeOnFirstLogin!", "placeholder")]
    [InlineData("Bootstrap:AdminEmail", null, "AdminEmail")]
    [InlineData("Bootstrap:AdminEmail", "not-an-email", "not an email")]
    [InlineData("Bootstrap:TenantSlug", null, "TenantSlug")]
    [InlineData("Bootstrap:TenantSlug", "crusaders.frostaura.net", "letters, digits and hyphens")]
    [InlineData("Bootstrap:TenantDisplayName", null, "TenantDisplayName")]
    [InlineData("Bootstrap:Courts", "0", "between 1 and 64")]
    [InlineData("Bootstrap:Courts", "500", "between 1 and 64")]
    public async Task Unusable_configuration_stops_the_container_and_names_the_key(string key, string? value, string expected)
    {
        var sp = await EmptyAsync();

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(sp, Config((key, value))));

        Assert.Contains(expected, ex.Message, StringComparison.OrdinalIgnoreCase);
        // And it must not have half-created anything on the way to failing.
        Assert.Empty(await Db(sp).Tenants.IgnoreQueryFilters().ToListAsync());
    }

    [Fact]
    public async Task Every_configuration_problem_is_reported_at_once_rather_than_one_reboot_at_a_time()
    {
        var sp = await EmptyAsync();

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(sp, Config(
            ("Bootstrap:AdminPassword", "short"),
            ("Bootstrap:AdminEmail", "nope"),
            ("Bootstrap:TenantDisplayName", null))));

        Assert.Contains("AdminPassword", ex.Message);
        Assert.Contains("AdminEmail", ex.Message);
        Assert.Contains("TenantDisplayName", ex.Message);
    }

    /// <summary>
    /// The slug is what TenantResolutionMiddleware matches the hostname's first label against.
    /// A mismatch here is the original outage wearing a different hat, so the message has to
    /// say what the value is FOR, not merely that it is required.
    /// </summary>
    [Fact]
    public async Task The_slug_error_explains_that_it_must_match_the_hostname()
    {
        var sp = await EmptyAsync();

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(sp, Config(("Bootstrap:TenantSlug", null))));

        Assert.Contains("subdomain", ex.Message, StringComparison.OrdinalIgnoreCase);
    }
}
