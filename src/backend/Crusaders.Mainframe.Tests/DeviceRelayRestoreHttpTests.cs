using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// GOAL item 17 — the courts come back on after a power cut.
///
/// <para>
/// <b>What happens today, and why it is not a small bug.</b> Mains blinks; both halves of the
/// box reset; the Mega drives every relay to released, correctly, because that is what makes a
/// watchdog reset safe. The ESP reconnects and heartbeats. <b>The response contains nothing
/// about relays</b> — there is no such field and there could not be, because until
/// <c>court_light_state</c> shipped nothing on the server knew what a relay was doing. So the
/// courts stay dark. The member's booking is still live, they have already been charged, and
/// the roster will not re-admit them cleanly: nothing is held, so a second scan is a fresh
/// grant and a second activation event.
/// </para>
///
/// <para>
/// These tests drive the real heartbeat over real HTTP, because the failure is a field that is
/// absent from a response a board in a cupboard reads with a heapless scanner.
/// </para>
/// </summary>
public sealed class DeviceRelayRestoreHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DeviceRelayRestoreHttpTests(PostgresFixture pg) => _pg = pg;

    private const string HeartbeatPath = "/api/v1/device/heartbeat";

    private sealed record Box(
        Guid DeviceId, string Mac, string ApiKey, Guid TenantId, string Slug,
        IReadOnlyDictionary<int, Guid> CourtIds, Guid MemberId, string Timezone);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>A club with a funded member and one box driving <paramref name="courtNumbers"/> in relay order.</summary>
    private static async Task<Box> SeedAsync(TestWebAppFactory factory, params int[] courtNumbers)
    {
        courtNumbers = courtNumbers.Length == 0 ? [1, 2, 3, 4] : courtNumbers;
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var timezone = TestHost.DayZoneFor(DateTimeOffset.UtcNow, RelayHardCap.Minutes);
        var slug = $"rst-{Guid.NewGuid():N}"[..20];

        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = "Restore Club",
            DeviceApiKey = DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,"timezone":"{{timezone}}","peak_hours":"16:00-19:00"}""",
        });

        var courts = courtNumbers
            .Select(n => new Court { TenantId = tenant.Id, CourtNumber = n, Name = $"Court {n}" })
            .ToList();
        db.Courts.AddRange(courts);

        var member = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "Priya Naidoo",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
        });

        var mac = Guid.NewGuid().ToString("N")[..12];
        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = $"box-{mac[^6..]}",
            Name = "Court box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            MacAddress = mac,
            CourtNumbers = [.. courtNumbers],
        };
        db.Devices.Add(device);

        await db.SaveChangesAsync();

        return new Box(device.Id, mac, tenant.DeviceApiKey!, tenant.Id, slug,
            courts.ToDictionary(c => c.CourtNumber, c => c.Id), member.Id, timezone);
    }

    /// <summary>
    /// A live booking on <paramref name="courtNumber"/> that the member has already scanned
    /// for — the state the power cut interrupts.
    /// </summary>
    private static async Task<Guid> LitBookingAsync(
        TestWebAppFactory factory, Box box, int courtNumber, int minutesRemaining,
        bool checkedIn = true, bool cancelled = false, bool sweptOff = false)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var now = TestHost.UtcNowStorable();

        var booking = new Booking
        {
            TenantId = box.TenantId,
            CourtId = box.CourtIds[courtNumber],
            UserId = box.MemberId,
            BookedByUserId = box.MemberId,
            PaidByUserId = box.MemberId,
            ActorUserId = box.MemberId,
            StartsAt = now.AddMinutes(-10),
            EndsAt = now.AddMinutes(minutesRemaining),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedMinutes = 32,
            Status = cancelled ? BookingStatus.Cancelled : BookingStatus.Booked,
            CheckedInAt = checkedIn ? now.AddMinutes(-10) : null,
            LightsOnCuedAt = checkedIn ? now.AddMinutes(-10) : null,
            LightsOffCuedAt = sweptOff ? now.AddMinutes(-1) : null,
            CancelledAt = cancelled ? now.AddMinutes(-5) : null,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking.Id;
    }

    private static HttpRequestMessage Heartbeat(Box box, object? extra = null)
    {
        var body = JsonSerializer.SerializeToNode(extra ?? new { })!.AsObject();
        body["mac"] = box.Mac;
        body["uptime_ms"] = 30_000;

        var req = new HttpRequestMessage(HttpMethod.Post, HeartbeatPath)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", box.ApiKey);
        return req;
    }

    private static async Task<JsonElement> BeatAsync(HttpClient client, Box box, object? extra = null)
    {
        var res = await client.SendAsync(Heartbeat(box, extra));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    private static string[] RelaysOf(JsonElement body)
    {
        Assert.True(body.TryGetProperty("relays", out var relays),
            "the heartbeat response carries no `relays` key at all — a box coming back from a power cut has nothing to restore from");
        return [.. relays.EnumerateArray().Select(e => e.GetString()!)];
    }

    /// <summary>
    /// The finding itself: a court that was lit when the power went is told to come back on,
    /// with the time the member actually has left.
    ///
    /// <para>
    /// <b>Mutant:</b> drop the <c>relays</c> key, or compute the remaining seconds from
    /// <c>StartsAt</c> instead of <c>EndsAt</c>. Either leaves the member in the dark on a
    /// court they have paid for and the server thinks is in use.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_court_that_was_lit_when_the_power_went_is_restored_with_the_time_that_is_left()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1, 2, 3, 4);
        var bookingId = await LitBookingAsync(factory, box, courtNumber: 2, minutesRemaining: 30);
        using var client = factory.CreateClient();

        var relays = RelaysOf(await BeatAsync(client, box));

        var element = Assert.Single(relays);
        var parts = element.Split('|');
        Assert.Equal(3, parts.Length);

        // Relay 1, because court 2 is the SECOND entry in this box's court list and the list
        // IS the relay mapping. A restore that names the court number would light court 1.
        Assert.Equal("1", parts[0]);

        var remaining = int.Parse(parts[1]);
        Assert.InRange(remaining, 29 * 60, 30 * 60 + 5);

        Assert.Equal(bookingId.ToString("N")[..8], parts[2]);
    }

    /// <summary>
    /// A member who switched their own lights off before the dip is NOT re-lit.
    ///
    /// <para>
    /// <b>This is the case the server's own columns cannot see.</b> <c>LightsOffCuedAt</c> is
    /// set by the slot-end sweep, never by the device, so a member who pressed OFF at 19:10 on
    /// a 19:45 booking looks — to every column on the booking — exactly like a member still
    /// playing. The only evidence is the box's own <c>release</c> receipt. Without the receipts
    /// clause the box comes back from the dip and lights an empty court until the slot ends.
    /// </para>
    ///
    /// <para><b>Mutant:</b> delete the receipts clause. This goes red; nothing else does.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_member_who_switched_the_lights_off_before_the_dip_is_not_re_lit()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1, 2);
        await LitBookingAsync(factory, box, courtNumber: 1, minutesRemaining: 40);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = box.TenantId,
                DeviceId = box.DeviceId,
                BootId = 0,
                Seq = 7,
                Kind = "release",
                Court = 0,
                OccurredAt = TestHost.UtcNowStorable().AddMinutes(-2),
            });
            await db.SaveChangesAsync();
        }

        using var client = factory.CreateClient();
        Assert.Empty(RelaysOf(await BeatAsync(client, box)));
    }

    /// <summary>
    /// Nothing to restore is an EMPTY array, not an absent key.
    ///
    /// <para>
    /// The two mean different things on the wire and the firmware acts on the difference: an
    /// absent key is "this API does not do restore" and the box stops waiting; an empty array
    /// is "nothing should be on", which is information at boot. <b>Neither switches anything
    /// off</b> — making an empty array an off-command would hand the API a way to darken a
    /// court somebody is playing on.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Nothing_to_restore_is_an_empty_array_rather_than_a_missing_key()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1, 2);
        using var client = factory.CreateClient();

        Assert.Empty(RelaysOf(await BeatAsync(client, box)));
    }

    /// <summary>
    /// A grant that ended during the outage is not restored — and a booking nobody ever
    /// scanned for is not restored either.
    ///
    /// <para>
    /// The second half is the one that would burn the club's electricity all evening:
    /// restoring from the ROSTER rather than from attendance would light every court with a
    /// live booking whether or not anybody had arrived.
    /// </para>
    ///
    /// <para><b>Mutant:</b> drop the <c>CheckedInAt != null</c> clause, or the <c>EndsAt &gt; now</c> one.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_grant_that_ended_during_the_outage_and_a_booking_nobody_scanned_for_are_both_left_dark()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1, 2, 3);

        // Court 1: checked in, but the slot ended while the power was off.
        await LitBookingAsync(factory, box, courtNumber: 1, minutesRemaining: -5);
        // Court 2: live, paid for, and nobody ever scanned.
        await LitBookingAsync(factory, box, courtNumber: 2, minutesRemaining: 40, checkedIn: false);
        // Court 3: checked in, then cancelled.
        await LitBookingAsync(factory, box, courtNumber: 3, minutesRemaining: 40, cancelled: true);

        using var client = factory.CreateClient();
        Assert.Empty(RelaysOf(await BeatAsync(client, box)));
    }

    /// <summary>
    /// A booking the slot-end sweep has already cued off is not restored.
    ///
    /// <para><b>Mutant:</b> drop the <c>LightsOffCuedAt == null</c> clause.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_booking_the_sweep_has_cued_off_is_not_restored()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1);
        await LitBookingAsync(factory, box, courtNumber: 1, minutesRemaining: 30, sweptOff: true);

        using var client = factory.CreateClient();
        Assert.Empty(RelaysOf(await BeatAsync(client, box)));
    }

    /// <summary>
    /// Two boxes in one club each restore their OWN relays, and a court number is never
    /// confused for a relay index.
    ///
    /// <para>
    /// The second box drives courts 3 and 4 as relays 0 and 1. A restore that leaked the
    /// club's whole picture, or that sent court numbers where relay indices belong, would tell
    /// this box to light relay 2 — which it does not have — or tell box one to light a court
    /// it does not drive.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Two_boxes_each_restore_only_their_own_relays()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var first = await SeedAsync(factory, 1, 2);

        Box second;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var courts = new[] { 3, 4 }
                .Select(n => new Court { TenantId = first.TenantId, CourtNumber = n, Name = $"Court {n}" })
                .ToList();
            db.Courts.AddRange(courts);

            var mac = Guid.NewGuid().ToString("N")[..12];
            var device = new Device
            {
                TenantId = first.TenantId,
                DeviceCode = $"box-{mac[^6..]}",
                Name = "Second box",
                Kind = DeviceKind.CourtBox,
                Hardware = DeviceHardware.Esp8266,
                MacAddress = mac,
                CourtNumbers = [3, 4],
            };
            db.Devices.Add(device);
            await db.SaveChangesAsync();

            second = first with
            {
                DeviceId = device.Id,
                Mac = mac,
                CourtIds = courts.ToDictionary(c => c.CourtNumber, c => c.Id),
            };
        }

        await LitBookingAsync(factory, first, courtNumber: 2, minutesRemaining: 30);
        await LitBookingAsync(factory, second, courtNumber: 4, minutesRemaining: 30);

        using var client = factory.CreateClient();

        Assert.StartsWith("1|", Assert.Single(RelaysOf(await BeatAsync(client, first))));
        Assert.StartsWith("1|", Assert.Single(RelaysOf(await BeatAsync(client, second))));
    }

    /// <summary>
    /// Another club's lit court never appears in this club's restore.
    ///
    /// <para>
    /// The non-negotiable cross-tenant test, on a surface authenticated by a club's own device
    /// key: a leak here would tell one club's box to light another club's court, and the
    /// booking reference on the wire would name a booking its admins cannot see.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_lit_court_is_never_in_this_clubs_restore()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var mine = await SeedAsync(factory, 1, 2);
        var theirs = await SeedAsync(factory, 1, 2);

        await LitBookingAsync(factory, theirs, courtNumber: 1, minutesRemaining: 45);

        using var client = factory.CreateClient();
        Assert.Empty(RelaysOf(await BeatAsync(client, mine)));
        Assert.Single(RelaysOf(await BeatAsync(client, theirs)));
    }

    /// <summary>
    /// Serving a restore is recorded, and the following heartbeat's <c>restored_relays</c>
    /// closes the loop — or says the box heard and did not act.
    ///
    /// <para>
    /// <b>The failure row is the one an admin must see.</b> "Served, and the box reported it
    /// restored nothing" means a court is dark that the club believes is lit, with a member on
    /// it who has already been charged. It is the highest-value single row on the control
    /// board.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_served_restore_that_the_box_did_not_act_on_is_recorded_as_a_failure()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1);
        await LitBookingAsync(factory, box, courtNumber: 1, minutesRemaining: 30);
        using var client = factory.CreateClient();

        Assert.Single(RelaysOf(await BeatAsync(client, box)));
        await BeatAsync(client, box, new { restored_relays = 0 });

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var actions = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == box.TenantId && a.Action.StartsWith("device.relay_restore"))
            .Select(a => a.Action)
            .ToListAsync();

        Assert.Contains("device.relay_restore_served", actions);
        Assert.Contains("device.relay_restore_failed", actions);
    }

    /// <summary>
    /// A confirmed restore writes the <c>lights_restored</c> record and puts the court back on
    /// the server's own books as restored after a power loss — not as a scan nobody made.
    ///
    /// <para><b>Mutant:</b> record the cause as <c>Member</c>. The control board and the night
    /// trace would then claim the member scanned at a box that was face-down in a reboot.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_confirmed_restore_is_recorded_as_restored_after_power_loss_and_not_as_a_scan()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1);
        await LitBookingAsync(factory, box, courtNumber: 1, minutesRemaining: 30);
        using var client = factory.CreateClient();

        Assert.Single(RelaysOf(await BeatAsync(client, box)));
        await BeatAsync(client, box, new { restored_relays = 1 });

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var state = await db.CourtLightStates.IgnoreQueryFilters()
            .FirstAsync(s => s.CourtId == box.CourtIds[1]);
        Assert.Equal(LightState.On, state.State);
        Assert.Equal(LightCause.RestoreAfterPowerDip, state.Cause);

        Assert.True(await db.AuditLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.TenantId == box.TenantId && a.Action == CourtLightStateService.LightsRestoredAction),
            "a confirmed restore wrote no lights_restored record, so the control board cannot say the court came back after a power cut");

        Assert.True(await db.AuditLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.TenantId == box.TenantId && a.Action == "device.relay_restore_confirmed"));
    }

    /// <summary>
    /// A restore is idempotent and never charges twice.
    ///
    /// <para>
    /// The restore queues no activation event and re-stamps no attendance — the API is the
    /// SOURCE of the restore, so it has already heard about it. A box that boots twice against
    /// a still-live booking gets told twice and the member's ledger does not move either time.
    /// </para>
    ///
    /// <para><b>Mutant:</b> route the restore through the activation service. The member is
    /// charged once per power cut.</para>
    /// </summary>
    [SkippableFact]
    public async Task Restoring_twice_charges_nothing_and_stamps_no_second_attendance()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1);
        var bookingId = await LitBookingAsync(factory, box, courtNumber: 1, minutesRemaining: 30);
        using var client = factory.CreateClient();

        DateTimeOffset checkedInBefore;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            checkedInBefore = (await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId)).CheckedInAt!.Value;
        }

        await BeatAsync(client, box);
        await BeatAsync(client, box, new { restored_relays = 1 });
        await BeatAsync(client, box);
        await BeatAsync(client, box, new { restored_relays = 1 });

        using var after = factory.Services.CreateScope();
        var db2 = after.ServiceProvider.GetRequiredService<MainframeDbContext>();

        Assert.Equal(0, await db2.LedgerEntries.IgnoreQueryFilters()
            .CountAsync(l => l.TenantId == box.TenantId && l.RelatedBookingId == bookingId));

        var booking = await db2.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId);
        Assert.Equal(checkedInBefore, booking.CheckedInAt);
    }

    /// <summary>
    /// A WALK-UP is restored too, and named.
    ///
    /// <para>
    /// <b>It would be easy to leave out and impossible to notice.</b> A walk-up is a real
    /// booking row — <c>CreateWalkUpAsync</c> writes one with the buyer as its user and the
    /// purchase instant as both its start and its charge — so the restore predicate covers it
    /// by construction rather than by a special case. But "by construction" is exactly the
    /// kind of claim that stops being true when somebody adds a clause, and the member it
    /// would strand is the one who has just paid cash at the box for the next forty minutes
    /// and has no booking on any screen to point at.
    /// </para>
    ///
    /// <para>
    /// The only thing on the row that tells a walk-up from a booking is
    /// <c>ChargedAt == StartsAt</c>, which is what the fixture reproduces.
    /// </para>
    ///
    /// <para><b>Mutant:</b> add "and the booking was made before it started" to the predicate —
    /// a plausible-looking guard that silently excludes every walk-up.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_walk_up_is_restored_just_as_a_booking_is()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1);

        Guid bookingId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var now = TestHost.UtcNowStorable();
            var booking = new Booking
            {
                TenantId = box.TenantId,
                CourtId = box.CourtIds[1],
                UserId = box.MemberId,
                BookedByUserId = box.MemberId,
                PaidByUserId = box.MemberId,
                ActorUserId = box.MemberId,

                // A walk-up starts the instant it is sold, and is charged at that same
                // instant — one `now` serves both in CreateWalkUpAsync.
                StartsAt = now.AddMinutes(-5),
                ChargedAt = now.AddMinutes(-5),
                EndsAt = now.AddMinutes(35),
                SliceMinutes = 15,
                SliceCount = 3,
                AmountChargedMinutes = 24,
                Status = BookingStatus.Booked,
                CheckedInAt = now.AddMinutes(-5),
                LightsOnCuedAt = now.AddMinutes(-5),
            };
            db.Bookings.Add(booking);
            await db.SaveChangesAsync();
            bookingId = booking.Id;
        }

        using var client = factory.CreateClient();
        var element = Assert.Single(RelaysOf(await BeatAsync(client, box)));
        var parts = element.Split('|');

        Assert.Equal("0", parts[0]);
        Assert.InRange(int.Parse(parts[1]), 34 * 60, 35 * 60 + 5);
        Assert.Equal(bookingId.ToString("N")[..8], parts[2]);

        // And the confirmation names the member who bought it, so the control board does not
        // say "restored after power loss" against nobody for a court somebody is standing on.
        await BeatAsync(client, box, new { restored_relays = 1 });

        using var after = factory.Services.CreateScope();
        var db2 = after.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var state = await db2.CourtLightStates.IgnoreQueryFilters().FirstAsync(s => s.CourtId == box.CourtIds[1]);

        Assert.Equal(LightState.On, state.State);
        Assert.Equal(LightCause.RestoreAfterPowerDip, state.Cause);
        Assert.Equal(box.MemberId, state.CausedByUserId);
        Assert.Equal(bookingId, state.BookingId);
    }

    /// <summary>
    /// The box's own <c>relay_state</c> report becomes the <c>confirmed</c> half of the
    /// control board — and an ABSENT key confirms nothing.
    ///
    /// <para>
    /// <b>Three states, not two.</b> Every board in the field runs firmware that sends no
    /// <c>relay_state</c> at all, so reading absence as "the box reports nothing is closed"
    /// would paint "confirmed off" across every court in every club on the current image.
    /// An EMPTY array is the box actively saying nothing is closed, which does confirm off.
    /// </para>
    ///
    /// <para>
    /// The report never overwrites the server's BELIEF: a box saying a relay is open while the
    /// server believes it granted time is a contradiction an admin must see, not one the
    /// server should resolve by adopting the box's view and losing the evidence that they
    /// disagreed.
    /// </para>
    ///
    /// <para><b>Mutant:</b> fold the report into <c>State</c>, or default a missing key to an
    /// empty list.</para>
    /// </summary>
    [SkippableFact]
    public async Task The_boxs_own_relay_report_confirms_without_overwriting_what_the_server_believes()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1, 2);
        using var client = factory.CreateClient();

        // No key at all: nothing is confirmed, in either direction.
        await BeatAsync(client, box);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var rows = await db.CourtLightStates.IgnoreQueryFilters()
                .Where(s => s.TenantId == box.TenantId).ToListAsync();
            Assert.All(rows, r => Assert.Null(r.ConfirmedAt));
        }

        // The box reports relay 0 closed and says nothing about relay 1 — which, in a report
        // that arrived, is a positive statement that relay 1 is open.
        await BeatAsync(client, box, new { relay_state = new[] { "0|1834" } });

        using var after = factory.Services.CreateScope();
        var db2 = after.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var first = await db2.CourtLightStates.IgnoreQueryFilters().FirstAsync(s => s.CourtId == box.CourtIds[1]);
        var second = await db2.CourtLightStates.IgnoreQueryFilters().FirstAsync(s => s.CourtId == box.CourtIds[2]);

        Assert.NotNull(first.ConfirmedAt);
        Assert.Equal(LightState.On, first.ConfirmedState);
        Assert.NotNull(second.ConfirmedAt);
        Assert.Equal(LightState.Off, second.ConfirmedState);

        // …and the BELIEF is untouched. Nothing has activated anything, so it is still unknown.
        Assert.Equal(LightState.Unknown, first.State);
    }

    /// <summary>
    /// A restore is not served to a club that has switched it off, and the key is then ABSENT
    /// rather than empty — which is how the box knows not to wait for one.
    /// </summary>
    [SkippableFact]
    public async Task A_club_that_switched_restore_off_gets_no_relays_key_at_all()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        using var factory = CreateFactory();
        var box = await SeedAsync(factory, 1);
        await LitBookingAsync(factory, box, courtNumber: 1, minutesRemaining: 30);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == box.TenantId);
            row.SettingsJson = row.SettingsJson[..^1] + ""","relay_restore_enabled":false}""";
            await db.SaveChangesAsync();
        }

        using var client = factory.CreateClient();
        var body = await BeatAsync(client, box);

        Assert.False(body.TryGetProperty("relays", out _),
            "a club with restore switched off still received a relays key, so its boxes will wait for a restore that is never coming");
    }
}
