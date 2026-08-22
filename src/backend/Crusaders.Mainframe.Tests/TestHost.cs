using Crusaders.Mainframe.Api.Biometric;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Lightweight in-memory test host. Builds a DI container with EF Core InMemory + a stub email service.
/// Use a fresh host per test for isolation.
/// </summary>
public sealed class TestHost : IAsyncDisposable
{
    public IServiceProvider Services { get; }
    public Tenant Tenant { get; }
    public User AdminUser { get; }
    public User PlayerUser { get; }                  // Regular member
    public User LeaguePlayerUser { get; }            // LeagueOrSenior member
    public List<Court> Courts { get; }
    public StubEmailService EmailService { get; }

    public TestHost(string dbName, Tenant tenant, User adminUser, User playerUser, User leagueUser, List<Court> courts,
        IServiceProvider services, StubEmailService emailService)
    {
        Tenant = tenant; AdminUser = adminUser; PlayerUser = playerUser; LeaguePlayerUser = leagueUser;
        Courts = courts; Services = services; EmailService = emailService;
    }

    /// <summary>
    /// Builds an isolated host. Pass <paramref name="sharedDatabaseName"/> to place two
    /// tenants in the SAME database, which is the only way a cross-tenant test proves
    /// anything: with a database per host, tenant B is empty because it is a different
    /// store, and the assertion holds even with every query filter deleted.
    /// </summary>
    public static async Task<TestHost> CreateAsync(string? tenantSlug = null, string? sharedDatabaseName = null)
    {
        var dbName = sharedDatabaseName ?? $"crusaders-test-{Guid.NewGuid():N}";
        var slug = tenantSlug ?? "crusaders";

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:Secret"] = "TEST_SECRET_THAT_IS_DEFINITELY_LONG_ENOUGH_FOR_HS256",
                ["Jwt:Issuer"] = "test",
                ["Jwt:Audience"] = "test",
                ["App:PublicBaseUrl"] = "http://localhost:8088",
                ["Smtp:Host"] = "stub",
                ["Smtp:From"] = "noreply@test.local",
            }).Build());
        services.AddDbContext<MainframeDbContext>(o => o.UseInMemoryDatabase(dbName));

        var tenantContext = new TenantContext();
        services.AddScoped<ITenantContext>(_ => tenantContext);

        services.AddSingleton<IPasswordHasher, Pbkdf2PasswordHasher>();
        services.AddScoped<IJwtIssuer, JwtIssuer>();
        var emailStub = new StubEmailService();
        services.AddSingleton<IEmailService>(emailStub);
        services.AddSingleton<IEventBus, InMemoryEventBus>();
        services.AddSingleton<IBiometricDevice, NullBiometricDevice>();
        // Mirrors Program.cs — the hardware abstraction and its key deriver must be
        // registered in both, or a test host diverges from the app it stands in for.
        services.AddSingleton<Crusaders.Mainframe.Api.Security.DeviceAuth.IDeviceKeyDeriver>(
            _ => new Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceKeyDeriver(
                new Microsoft.Extensions.Configuration.ConfigurationBuilder()
                    .AddInMemoryCollection(new Dictionary<string, string?>
                    {
                        ["Devices:MasterKey"] = "test-only-device-master-key-thirty-two-plus-bytes",
                    }).Build()));
        services.AddMemoryCache();
        services.AddSingleton<BalanceBroadcaster>();
        services.AddScoped<TenantSettingsAccessor>();
        services.AddScoped<DeviceRegistryService>();
        services.AddScoped<Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceVerifier>();
        services.AddScoped<LedgerService>();
        services.AddScoped<ScheduleService>();
        services.AddScoped<BookingService>();
        services.AddScoped<BiometricService>();
        services.AddScoped<AuthService>();
        services.AddScoped<MemberApprovalService>();

        var sp = services.BuildServiceProvider();

        // Seed (in-memory provider doesn't run real EF migrations; EnsureCreated stands up the schema for tests).
        using (var scope = sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
            await db.Database.EnsureCreatedAsync();

            var tenant = new Tenant { Slug = slug, DisplayName = "Test Club" };
            db.Tenants.Add(tenant);
            db.TenantSettings.Add(new TenantSettings
            {
                TenantId = tenant.Id,
                // Crusaders-defaults per the client blueprint Rev 2:
                //  - slice 15 min, slice price 8 credits
                //  - conversion: regular 1.6, league 2.4
                //  - block R100 cap R1000, per-day cap 60 min
                //  - peak 16:00-19:00, regular-advance 1h
                // Test fixture uses UTC for deterministic time-math.
                SettingsJson = """{"slice_minutes":15,"slice_price_credits":8,"penalty_pct":30,"grace_window_minutes":5,"penalty_window_minutes":15,"advance_booking_days":14,"timezone":"UTC","credits_per_zar_regular":1.6,"credits_per_zar_league":2.4,"topup_block_zar":100,"topup_max_zar_per_member":1000,"member_per_day_max_minutes":60,"peak_hours":"16:00-19:00","peak_advance_hours_for_regular":1,"retention_years":2}""",
            });

            var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = hasher.Hash("AdminPass!"), EmailVerified = true, IsAdmin = true };
            var player = new User { TenantId = tenant.Id, Email = $"player-{slug}@test.local", PasswordHash = hasher.Hash("PlayerPass!"), EmailVerified = true };
            var league = new User { TenantId = tenant.Id, Email = $"league-{slug}@test.local", PasswordHash = hasher.Hash("LeaguePass!"), EmailVerified = true };
            db.Users.AddRange(admin, player, league);
            db.Memberships.AddRange(
                new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Test Admin", MembershipNumber = "ADMIN-1", Status = MembershipStatus.Active, MemberClass = MemberClass.Regular },
                new Membership { TenantId = tenant.Id, UserId = player.Id, FullName = "Test Player", MembershipNumber = "PLAYER-1", Status = MembershipStatus.Active, MemberClass = MemberClass.Regular },
                new Membership { TenantId = tenant.Id, UserId = league.Id, FullName = "Test League", MembershipNumber = "LEAGUE-1", Status = MembershipStatus.Active, MemberClass = MemberClass.LeagueOrSenior }
            );
            var courts = new List<Court>();
            for (var i = 1; i <= 4; i++) courts.Add(new Court { TenantId = tenant.Id, CourtNumber = i, Name = $"Court {i}", SlicePriceCredits = 8m });
            db.Courts.AddRange(courts);
            await db.SaveChangesAsync();

            tenantContext.Set(tenant.Id, tenant.Slug);
            return new TestHost(dbName, tenant, admin, player, league, courts, sp, emailStub);
        }
    }

    public IServiceScope NewScope() => Services.CreateScope();

    public async ValueTask DisposeAsync()
    {
        if (Services is IAsyncDisposable a) await a.DisposeAsync();
        else if (Services is IDisposable d) d.Dispose();
    }
}

public sealed class StubEmailService : IEmailService
{
    public List<EmailMessage> Sent { get; } = new();
    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        Sent.Add(message);
        return Task.CompletedTask;
    }
}
