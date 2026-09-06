using System.Text.Json.Nodes;
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

    /// <summary>
    /// This host's own media root, matching <c>Media:StoragePath</c> in its configuration.
    ///
    /// <para>
    /// Per-host and under the temp directory rather than the default <c>./media</c>, which is
    /// relative to the test runner's working directory and therefore shared by every host in
    /// the run. Registration writes files here, and a test that asserts a file was removed
    /// cannot be reading a directory another test is writing into.
    /// </para>
    /// </summary>
    public string MediaRoot { get; }

    public TestHost(string dbName, Tenant tenant, User adminUser, User playerUser, User leagueUser, List<Court> courts,
        IServiceProvider services, StubEmailService emailService, string mediaRoot)
    {
        Tenant = tenant; AdminUser = adminUser; PlayerUser = playerUser; LeaguePlayerUser = leagueUser;
        Courts = courts; Services = services; EmailService = emailService; MediaRoot = mediaRoot;
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
        var mediaRoot = Path.Combine(Path.GetTempPath(), $"crusaders-media-{Guid.NewGuid():N}");

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
                ["Media:StoragePath"] = mediaRoot,
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
        // IRelayClient is not registered here either, for the reason Program.cs gives: the
        // court box is pull-only, nothing resolves one, and a test host that registered a
        // service the app does not would be the divergence this comment exists to prevent.
        // LightsCueTests constructs NullRelayClient directly to pin the interface's shape.
        services.AddMemoryCache();
        services.AddSingleton<BalanceBroadcaster>();
        // Sign-out revocation. A singleton in the app too — a per-scope list would forget every
        // sign-out the moment the request that made it ended.
        services.AddSingleton<AccessTokenRevocationList>();
        services.AddScoped<TenantSettingsAccessor>();
        services.AddScoped<AccessCodeService>();
        services.AddScoped<IdentificationResolver>();
        services.AddScoped<DeviceRegistryService>();
        // Mirrors Program.cs. A test host that lacks something the application registers is
        // a host that diverges from the app it stands in for.
        services.AddScoped<Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceKeyResolver>();
        services.AddScoped<LedgerService>();
        services.AddScoped<ScheduleService>();
        services.AddScoped<BookingService>();
        services.AddScoped<CourtActivationService>();
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
                //
                // …and it is open 00:00-24:00 ON PURPOSE. Operating hours are now enforced
                // by BookingService, so a fixture that shut at 22:00 would make every test
                // that books `UtcNow.AddHours(2)` fail whenever the suite ran after 20:00
                // UTC — the same "passes all morning, fails after lunch" trap BookableSlot
                // below exists to close, arriving from a second direction. Tests ABOUT
                // operating hours set their own window; see OperatingHoursTests.
                SettingsJson = """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,"penalty_pct":30,"grace_window_minutes":5,"penalty_window_minutes":15,"advance_booking_days":14,"timezone":"UTC","credits_per_zar_regular":1.6,"credits_per_zar_league":2.4,"topup_block_zar":100,"topup_max_zar_per_member":1000,"member_per_day_max_minutes":60,"peak_hours":"16:00-19:00","peak_advance_hours_for_regular":1,"retention_years":2}""",
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
            return new TestHost(dbName, tenant, admin, player, league, courts, sp, emailStub, mediaRoot);
        }
    }

    /// <summary>
    /// <paramref name="instant"/> reduced to a value Postgres can store exactly: whole
    /// microseconds.
    ///
    /// <para>
    /// <b>This is a platform difference, not a clock-hour one, and it made CI red while the
    /// founder's machine stayed green through five consecutive runs.</b> <c>timestamptz</c> is
    /// a microsecond column, and .NET ticks are 100&#160;ns, so a persisted instant comes back
    /// with its last digit removed. On macOS that is invisible: <c>DateTimeOffset.UtcNow</c>
    /// there is read from a microsecond-resolution clock and its tick count is always a
    /// multiple of ten, so the round trip is exact and every equality assertion holds. On the
    /// Linux runner the same call is read from <c>clock_gettime</c> at full 100&#160;ns
    /// resolution, so nine times in ten the value carries a remainder the column cannot hold
    /// and <c>Assert.Equal(seeded, readBack)</c> fails by up to 900&#160;ns.
    /// </para>
    ///
    /// <para>
    /// So a fixture instant that any test will later compare for equality against a row it
    /// read back has to come through here first. It cost the branch five red CI runs on
    /// <c>ConcurrentDecisionTests.Sweeping_bookings_after_their_end_never_extends_one_into_the_next</c>,
    /// which reads as a booking that was extended into the next slot and is nothing of the
    /// kind — the two instants differ by three ticks. Diagnosing it from the founder's machine
    /// is impossible by construction, because the defect cannot occur there;
    /// <c>A_seeded_instant_survives_the_database_unchanged</c> manufactures the remainder
    /// instead of waiting for a clock to supply one, so it fails on both platforms without it.
    /// </para>
    /// </summary>
    public static DateTimeOffset Storable(DateTimeOffset instant)
        => instant.AddTicks(-(instant.UtcTicks % TimeSpan.TicksPerMicrosecond));

    /// <summary><see cref="Storable"/> applied to now — the clock a Postgres-backed fixture should seed from.</summary>
    public static DateTimeOffset UtcNowStorable() => Storable(DateTimeOffset.UtcNow);

    /// <summary>
    /// A bookable slot at least <paramref name="hoursAhead"/> from now that is <b>not</b>
    /// inside the fixture's peak window.
    ///
    /// <para>
    /// <c>DateTimeOffset.UtcNow.AddHours(3)</c> looks harmless and is not. The fixture
    /// sets <c>peak_hours</c> to 16:00–19:00 with the tenant timezone at UTC, and blueprint
    /// A.12 refuses a Regular member a peak slot more than an hour before it starts — so a
    /// test written that way passes all morning and fails every afternoon, with a cast
    /// exception that names <c>PeakHoursLeagueOnly</c> and points at a cancellation test.
    /// It cost a bisect that found nothing, because nothing had changed except the clock.
    /// </para>
    ///
    /// <para>
    /// Tests about peak hours should still construct their own times — the point of this is
    /// that tests about <i>anything else</i> stop depending on what time the suite runs.
    /// </para>
    /// </summary>
    public static DateTimeOffset BookableSlot(double hoursAhead = 2)
        => BookableSlotFrom(DateTimeOffset.UtcNow, hoursAhead);

    /// <summary>
    /// The same rule with the clock passed in, so the fix for a time-dependent test can
    /// itself be tested at every hour of the day rather than at whatever hour the suite
    /// happens to run.
    /// </summary>
    public static DateTimeOffset BookableSlotFrom(DateTimeOffset now, double hoursAhead)
    {
        var slot = now.AddHours(hoursAhead);

        // Step past the window rather than clamping to its edge: a slot starting at 15:59
        // can still END inside peak, and while the rule is evaluated on the start, the
        // intent here is to stay clear of it entirely.
        while (slot.Hour is >= 15 and < 19) slot = slot.AddHours(1);

        // And clear of the END of the club's day, for the same reason and by the same
        // mistake made once already.
        //
        // The operating-hours rule is evaluated on the slot's END:
        // `endMinute = startMinute + duration` against `day_end_minute`, which is 1440 in
        // this fixture. A 15-minute slot starting at 23:50 ends at 1445 and is refused
        // `OutOfHours` — a club that is open all day still cannot sell a court that runs
        // past midnight. So this helper's promise held for peak and quietly did not hold
        // for closing time, and MoneySurfaceTests, which asks for a slot two hours out in
        // the club's own clock, went red for roughly a quarter of an hour every night
        // and green for the rest of the day. That is the same "passes all morning, fails
        // after lunch" shape memory/gotchas.md already records, from the other end of the
        // day.
        //
        // Stepping out of hour 23 entirely, rather than trimming to fit, because callers
        // book up to four slices (an hour) on one slot and the headroom has to cover the
        // longest of them. One step is always enough: 23:xx + 1h is 00:xx, which is
        // neither peak nor the end of a day.
        if (slot.Hour == 23) slot = slot.AddHours(1);
        return slot;
    }

    /// <summary>
    /// A tenant timezone in which <b>now</b> is comfortably mid-day, so a purchase made AT
    /// this instant still has <paramref name="minutesNeeded"/> of the club's day in front of
    /// it — plus an hour of slack at each end.
    ///
    /// <para>
    /// <see cref="BookableSlotFrom"/> solves the same problem for a booking by moving the
    /// SLOT. A walk-up cannot be moved: <c>BookingService.CreateWalkUpAsync</c> reads its own
    /// <c>UtcNow</c> and sells from that instant, so a test that buys an hour is buying it at
    /// whatever o'clock the suite happens to run. The fixtures set <c>day_end_minute</c> to
    /// 1440, so the club closes at local midnight and a walk-up inside the last hour of the
    /// local day is truncated to closing time — five walk-up tests across three classes went
    /// red for the last hour of every day and green for the other twenty-three. The only
    /// thing left to move is the club, so this moves the club.
    /// </para>
    ///
    /// <para>
    /// <c>Etc/GMT+n</c> is <b>UTC−n</b> — the POSIX sign, inverted from how it reads — and
    /// none of these zones observes DST, so the offset is exactly the offset. Walking +14
    /// down to −12 visits every hour of the local clock, so a usable zone always exists;
    /// <c>The_day_zone_leaves_room_at_every_hour_of_the_day</c> is what proves that rather
    /// than trusting it.
    /// </para>
    /// </summary>
    public static string DayZoneFor(DateTimeOffset now, int minutesNeeded)
    {
        for (var offsetHours = 14; offsetHours >= -12; offsetHours--)
        {
            var local = now.UtcDateTime.AddHours(offsetHours);
            var minuteOfDay = (local.Hour * 60) + local.Minute;

            // An hour clear of opening (00:00 in every fixture that calls this) and an hour
            // clear of what the caller is about to buy, so a slow test cannot drift into
            // either edge while it runs.
            if (minuteOfDay >= 60 && minuteOfDay + minutesNeeded + 60 <= 1440)
            {
                return offsetHours switch
                {
                    0 => "Etc/UTC",
                    > 0 => $"Etc/GMT-{offsetHours}",
                    _ => $"Etc/GMT+{-offsetHours}",
                };
            }
        }

        throw new InvalidOperationException(
            $"No whole-hour zone leaves {minutesNeeded} minutes of the local day after {now:O}");
    }

    /// <summary>
    /// Moves a club into <see cref="DayZoneFor"/> so a walk-up bought right now is not
    /// truncated at closing time. Everything else about the settings document is untouched.
    /// </summary>
    public static async Task ClearOfClosingAsync(MainframeDbContext db, Guid tenantId, int minutesNeeded)
    {
        var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(s => s.TenantId == tenantId);
        var settings = JsonNode.Parse(row.SettingsJson)!.AsObject();
        settings["timezone"] = DayZoneFor(DateTimeOffset.UtcNow, minutesNeeded);
        row.SettingsJson = settings.ToJsonString();
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// <see cref="ClearOfClosingAsync"/>, handing back the instant the caller should measure
    /// its own times from.
    ///
    /// <para>
    /// The return value is the point. A test that writes
    /// <c>var startsAt = DateTimeOffset.UtcNow.AddMinutes(5)</c> and separately remembers to
    /// move the club has two independent statements, and deleting the second leaves a test
    /// that compiles, passes for twenty-three hours a day, and fails in the twenty-fourth.
    /// Taking <c>now</c> FROM the move makes the two one statement: remove it and the test
    /// no longer builds. That is the difference between a fix and a fix that stays.
    /// </para>
    ///
    /// <para>
    /// <paramref name="minutesNeeded"/> is everything the caller's operation will consume of
    /// the club's day measured from the returned instant — for a booking that starts in five
    /// minutes and runs fifteen, that is twenty, not fifteen.
    /// </para>
    /// </summary>
    public static async Task<DateTimeOffset> NowClearOfClosingAsync(
        MainframeDbContext db, Guid tenantId, int minutesNeeded)
    {
        await ClearOfClosingAsync(db, tenantId, minutesNeeded);
        return DateTimeOffset.UtcNow;
    }

    public IServiceScope NewScope() => Services.CreateScope();

    public async ValueTask DisposeAsync()
    {
        try { if (Directory.Exists(MediaRoot)) Directory.Delete(MediaRoot, recursive: true); }
        catch (IOException) { /* a leftover temp directory is not worth failing a test over */ }

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
