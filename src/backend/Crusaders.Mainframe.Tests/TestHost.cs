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
    /// <param name="inherentAdminEmails">
    /// <c>Admins:Emails</c> for this host. Null — the default every other test gets — leaves the
    /// section absent, which is what an ordinary deployment has and is why adding the feature
    /// changed no existing fixture.
    /// </param>
    public static async Task<TestHost> CreateAsync(
        string? tenantSlug = null, string? sharedDatabaseName = null, IReadOnlyList<string>? inherentAdminEmails = null)
    {
        var dbName = sharedDatabaseName ?? $"crusaders-test-{Guid.NewGuid():N}";
        var slug = tenantSlug ?? "crusaders";
        var mediaRoot = Path.Combine(Path.GetTempPath(), $"crusaders-media-{Guid.NewGuid():N}");

        var settings = new Dictionary<string, string?>
        {
            ["Jwt:Secret"] = "TEST_SECRET_THAT_IS_DEFINITELY_LONG_ENOUGH_FOR_HS256",
            ["Jwt:Issuer"] = "test",
            ["Jwt:Audience"] = "test",
            ["App:PublicBaseUrl"] = "http://localhost:8088",
            ["Smtp:Host"] = "stub",
            ["Smtp:From"] = "noreply@test.local",
            ["Media:StoragePath"] = mediaRoot,
        };
        for (var i = 0; i < (inherentAdminEmails?.Count ?? 0); i++)
        {
            settings[$"{InherentAdmins.SectionKey}:{i}"] = inherentAdminEmails![i];
        }

        var services = new ServiceCollection();
        services.AddLogging();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        services.AddSingleton<IConfiguration>(configuration);
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
        // The three-stream fan-out, the post-commit outbox in front of it, and the
        // light-state projection the activation path now writes. Registered here as well as
        // in Program.cs because this host builds its own container: a service missing from
        // one of the two is a suite that passes while the application cannot start, or the
        // reverse.
        services.AddSingleton<Crusaders.Mainframe.Api.Services.Realtime.IRealtimeBus,
                              Crusaders.Mainframe.Api.Services.Realtime.InProcessRealtimeBus>();
        services.AddScoped<Crusaders.Mainframe.Api.Services.Realtime.RealtimeOutbox>();
        services.AddScoped<CourtLightStateService>();
        services.AddScoped<DeviceErrorService>();
        services.AddScoped<DeviceFaultSink>();
        services.AddScoped<ControlBoardReader>();
        services.AddScoped<ActivationPlumbing>();
        // Sign-out revocation. A singleton in the app too — a per-scope list would forget every
        // sign-out the moment the request that made it ended.
        services.AddSingleton<AccessTokenRevocationList>();
        services.AddScoped<TenantSettingsAccessor>();
        // Which club a message is from. Program.cs registers it beside the settings
        // accessor for the same reason: every mail path needs it.
        services.AddScoped<Crusaders.Mainframe.Api.Email.ClubIdentityResolver>();
        services.AddScoped<MemberApprovalService.MemberNotifier>();
        services.AddScoped<AccessCodeService>();
        services.AddScoped<IdentificationResolver>();
        services.AddScoped<DeviceRegistryService>();
        // Mirrors Program.cs. A test host that lacks something the application registers is
        // a host that diverges from the app it stands in for.
        services.AddScoped<Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceKeyResolver>();
        services.AddScoped<LedgerService>();
        services.AddScoped<ScheduleService>();
        services.AddScoped<BookingRules>();
        services.AddScoped<BookingService>();
        services.AddScoped<CourtActivationService>();
        services.AddScoped<BiometricService>();
        // Mirrors Program.cs. The options object is read once and shared; the service that
        // applies it is per-request, because it writes through the request's DbContext.
        services.AddSingleton(InherentAdmins.From(configuration));
        services.AddScoped<InherentAdminService>();
        services.AddScoped<AuthService>();
        services.AddScoped<MemberApprovalService>();
        services.AddScoped<AdminBlockService>();
        // Mirrors Program.cs: the recorder reads the request's trace id and remote address off
        // the accessor, and a host that lacked one would make every admin change row in the
        // suite carry nulls the application never writes.
        services.AddHttpContextAccessor();
        services.AddScoped<AdminChangeRecorder>();
        services.AddScoped<AdminBulkBookingService>();
        services.AddScoped<BookingScheduleService>();
        services.AddScoped<UserPreferencesService>();
        // Mirrors Program.cs: the role cache is a singleton so an eviction reaches the reader.
        services.AddSingleton<LiveAdminRole>();
        services.AddScoped<AdminRoleService>();
        // Mirrors Program.cs: the admin notice outbox's two halves. Singletons over the scope
        // factory, exactly as the application registers them, so DeliverAdminNoticesAsync below
        // runs the real dispatcher against this host's store.
        services.AddSingleton<AdminNotificationDispatcher>();
        services.AddSingleton<AdminNotificationSweep>();

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
    ///
    /// <para>
    /// <b>Only for a club that is still at UTC.</b> The stepping happens on the offset of the
    /// instant handed in, and <c>UtcNow</c>'s is zero — so a fixture that has moved its club
    /// (every caller of <see cref="ClearOfClosingAsync"/>) must ask
    /// <see cref="BookableSlotAt"/> instead, or it is measuring the club's windows on the
    /// runner's clock.
    /// </para>
    /// </summary>
    public static DateTimeOffset BookableSlot(double hoursAhead = 2)
        => BookableSlotFrom(DateTimeOffset.UtcNow, hoursAhead);

    /// <summary>
    /// The same rule for a club that is <b>not</b> at UTC — every window this helper steps
    /// around is a window in the club's own clock, not in the runner's.
    ///
    /// <para>
    /// <b>This is the second half of the closing-time fix, and leaving it out was a defect
    /// of its own.</b> <see cref="ClearOfClosingAsync"/> moves a walk-up fixture's club out
    /// of UTC so a purchase made now is not truncated at local midnight. From that moment
    /// the club's peak window and the club's midnight are somewhere else in UTC, and a slot
    /// picked by the overload above — which steps on the offset of the instant it is given,
    /// zero for <c>UtcNow</c> — lands wherever it lands:
    /// <c>WalkUpBookingTests.A_walk_up_is_a_lights_purchase_and_a_booked_slot_is_a_booking_charge</c>
    /// asked for a slot three hours out at 23:50 UTC, got 02:50 UTC — plainly outside
    /// 16:00–19:00 — and was refused <c>PeakHoursLeagueOnly</c>, because its own fixture had
    /// just moved the club to UTC+14 and 02:50 UTC is 16:50 there. Fixing one wall-clock
    /// window by moving the club is how you create the next one.
    /// </para>
    /// </summary>
    /// <param name="now">
    /// The clock, so this method — and not only the arithmetic underneath it — can be swept
    /// over a whole day. The sweeps beside it pinned <see cref="BookableSlotFrom(DateTimeOffset,
    /// double, TimeZoneInfo?)"/> and left THIS wrapper unpinned, which is one layer below where
    /// every fixture actually enters: rewriting the body to pass <c>club: null</c> — the exact
    /// defect the paragraph above describes — left all forty tests in the walk-up class green at
    /// 02:31 UTC, because a wrapper that reads its own clock can only be caught at the unlucky
    /// hours. Threading the clock through is what makes it catchable at all of them.
    /// </param>
    public static DateTimeOffset BookableSlotAt(
        string clubTimezone, double hoursAhead = 2, DateTimeOffset? now = null)
        => BookableSlotFrom(
            now ?? DateTimeOffset.UtcNow, hoursAhead, TimeZoneInfo.FindSystemTimeZoneById(clubTimezone));

    /// <summary>
    /// The same rule with the clock passed in, so the fix for a time-dependent test can
    /// itself be tested at every hour of the day rather than at whatever hour the suite
    /// happens to run.
    /// </summary>
    public static DateTimeOffset BookableSlotFrom(DateTimeOffset now, double hoursAhead)
        => BookableSlotFrom(now, hoursAhead, club: null);

    /// <summary>
    /// <see cref="BookableSlotFrom(DateTimeOffset, double)"/> with both the clock and the
    /// club passed in — the form the every-minute sweep drives.
    ///
    /// <para>
    /// <paramref name="club"/> <c>null</c> means <b>the offset the value already carries</b>,
    /// which is the two-argument overload's long-standing contract and one that
    /// <c>MoneySurfaceTests.A_booking_charges_comment_is_in_the_clubs_wall_clock</c> depends
    /// on by name: it hands in <c>ConvertTime(UtcNow, Africa/Johannesburg)</c> precisely so
    /// the stepping happens in SAST. Forcing <see cref="TimeZoneInfo.Utc"/> there instead
    /// would have measured a SAST club's peak window on the runner's clock — the very defect
    /// the zone-aware overload exists to remove, reintroduced one file away.
    /// </para>
    /// </summary>
    public static DateTimeOffset BookableSlotFrom(DateTimeOffset now, double hoursAhead, TimeZoneInfo? club)
    {
        var slot = now.AddHours(hoursAhead);

        // Step past the window rather than clamping to its edge: a slot starting at 15:59
        // can still END inside peak, and while the rule is evaluated on the start, the
        // intent here is to stay clear of it entirely.
        while (LocalHour(slot, club) is >= 15 and < 19) slot = slot.AddHours(1);

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
        if (LocalHour(slot, club) == 23) slot = slot.AddHours(1);
        return slot;
    }

    /// <summary>
    /// The hour <paramref name="at"/> reads as on <paramref name="club"/>'s wall clock, or on
    /// its own offset when no club is given.
    /// </summary>
    private static int LocalHour(DateTimeOffset at, TimeZoneInfo? club)
        => club is null ? at.Hour : TimeZoneInfo.ConvertTime(at, club).Hour;

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
    ///
    /// <para>
    /// <b>It hands the zone back, and callers are expected to keep it.</b> A club that is no
    /// longer at UTC has its peak window and its midnight somewhere else in UTC too, so
    /// every other wall-clock choice the same fixture makes — <see cref="BookableSlotAt"/>,
    /// an operating-hours window written as a minute-of-day — has to be made in this zone
    /// rather than in the runner's. Returning it is what lets a caller hold one value
    /// instead of re-deriving it and getting a different answer a minute later.
    /// </para>
    /// </summary>
    /// <returns>The tzdb id written to the tenant's settings.</returns>
    public static async Task<string> ClearOfClosingAsync(MainframeDbContext db, Guid tenantId, int minutesNeeded)
    {
        var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(s => s.TenantId == tenantId);
        var settings = JsonNode.Parse(row.SettingsJson)!.AsObject();
        var zone = DayZoneFor(DateTimeOffset.UtcNow, minutesNeeded);
        settings["timezone"] = zone;
        row.SettingsJson = settings.ToJsonString();
        await db.SaveChangesAsync();
        return zone;
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

    /// <summary>
    /// Runs the admin notice outbox once at <paramref name="now"/> (default: the wall clock),
    /// so a test that raised an admin notice can assert on the mail it becomes.
    ///
    /// <para>
    /// <b>Why tests have to call this.</b> Admin mail is no longer sent by the path that raises
    /// it; the path stages an outbox row in its own save and the dispatcher mails it (R23). No
    /// host in this suite runs hosted services, so nothing delivers unless the test says so — and
    /// a test that ticks a worker at a stated instant must deliver at that same instant, or a
    /// notice stamped in the future of the wall clock is not yet due.
    /// </para>
    /// </summary>
    public Task<int> DeliverAdminNoticesAsync(DateTimeOffset? now = null) =>
        Services.GetRequiredService<AdminNotificationDispatcher>().DeliverDueAsync(now ?? DateTimeOffset.UtcNow, default);

    public async ValueTask DisposeAsync()
    {
        try { if (Directory.Exists(MediaRoot)) Directory.Delete(MediaRoot, recursive: true); }
        catch (IOException) { /* a leftover temp directory is not worth failing a test over */ }

        if (Services is IAsyncDisposable a) await a.DisposeAsync();
        else if (Services is IDisposable d) d.Dispose();
    }
}

/// <summary>
/// Collects the mail the app tried to send.
///
/// <para>
/// <b>Thread-safe on purpose.</b> Several paths — registration, the PayFast ITN, the desk's
/// credit adjustment — now hand their mail to <c>EmailDispatch.InBackground</c> rather than
/// awaiting SMTP inside the request, because a slow mail server was otherwise able to make a
/// member's browser abandon a registration that had already succeeded. That means this list is
/// appended from thread-pool threads while a test reads it, and a bare <c>List&lt;T&gt;</c> under
/// concurrent <c>Add</c> can lose entries or throw mid-enumeration. A test suite that fails
/// once a fortnight for no reason is worse than no test.
/// </para>
/// </summary>
public sealed class StubEmailService : IEmailService
{
    private readonly List<EmailMessage> _sent = new();
    private readonly object _gate = new();

    /// <summary>A snapshot. Safe to enumerate while background sends are still arriving.</summary>
    public IReadOnlyList<EmailMessage> Sent
    {
        get { lock (_gate) return _sent.ToList(); }
    }

    /// <summary>
    /// When set, a message it matches is refused the way a mail server that is down refuses it,
    /// and is NOT recorded as sent. For the outbox's retry tests: a mail that failed must not be
    /// in <see cref="Sent"/>, or a test could not tell a retry from a duplicate.
    /// </summary>
    public Func<EmailMessage, bool>? FailWhen { get; set; }

    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        if (FailWhen?.Invoke(message) == true)
        {
            throw new System.Net.Mail.SmtpException(
                System.Net.Mail.SmtpStatusCode.MailboxUnavailable, "Refused (test).");
        }
        lock (_gate) _sent.Add(message);
        return Task.CompletedTask;
    }

    public void Clear()
    {
        lock (_gate) _sent.Clear();
    }

    /// <summary>
    /// Waits for a matching mail, for the paths that dispatch in the background.
    ///
    /// <para>
    /// Three separate private Poll helpers had already grown in this suite for exactly this.
    /// This is the one place it belongs, next to the thing being polled.
    /// </para>
    /// </summary>
    public async Task<EmailMessage?> WaitFor(Func<EmailMessage, bool> match, int timeoutMs = 5000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            var hit = Sent.FirstOrDefault(match);
            if (hit is not null) return hit;
            await Task.Delay(20);
        }
        return Sent.FirstOrDefault(match);
    }
}
