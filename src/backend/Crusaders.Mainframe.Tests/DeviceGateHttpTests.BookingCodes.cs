using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

public abstract partial class DeviceGateHttpTests
{
    /// <summary>A booking code at the door: its window, what the phone shows, and a spent code for a member whose next court is due.</summary>
    public sealed class BookingCodes(PostgresFixture pg) : DeviceGateHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// <b><c>too_early</c> on the wire</b>, as a 200 like every other refusal, with a zero
        /// release — and the audit row that names it.
        ///
        /// <para>
        /// The same booking code, the same door, and the only thing that moves between the two
        /// halves is the booking's distance from now.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_booking_code_presented_too_early_is_refused_as_a_200_and_audited()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", BookingWindowSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");

            // Six hours out, against a thirty-minute entry window.
            var early = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddHours(6));
            await AssertRefusedAsync(
                client, Scan(club.Key, mac, await BookingCodeAsync(factory, club, early)), GateAccess.TooEarly);

            // Twenty minutes out is inside it, and the same member's own booking code opens the
            // door — so the refusal above is the window and not the code.
            var due = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));
            Assert.True((await BodyAsync(await client.SendAsync(
                Scan(club.Key, mac, await BookingCodeAsync(factory, club, due))))).GetProperty("opened").GetBoolean());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var denial = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId
                            && a.Action == $"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.TooEarly}")
                .ToListAsync());

            // Named, because a refusal that says who was turned away is the whole value of the row.
            Assert.Equal(club.MemberId, denial.SubjectUserId);
        }

        /// <summary>
        /// <b>The window the phone shows a booking code in and the window the door accepts it in
        /// are the same window</b>, driven here through both real routes.
        ///
        /// <para>
        /// <c>POST /me/qr/generate?kind=auto</c> is the member's screen and
        /// <c>POST /device/gate</c> is the door. Under the default policy they must agree: a door
        /// narrower than the screen refuses a code the product has just handed somebody, and a
        /// door wider than the screen is the standing building key this whole rule exists to end.
        /// They were two independent rearrangements of one predicate in two files.
        /// </para>
        ///
        /// <para>
        /// <b>This fails if either side changes alone</b>, which is the point of driving both
        /// rather than asserting the shared function twice. Widen the door and the far booking
        /// opens it while the phone still says <c>ident</c>; narrow it and the near booking is
        /// refused while the phone is showing its code. Move the phone's horizon and the two
        /// <c>kind</c> assertions go the other way.
        /// </para>
        ///
        /// <para>
        /// The horizon is <c>roster_window_minutes + activation_cue_window_minutes</c> = 130
        /// minutes here, and the two bookings sit ten minutes either side of it. The margin is
        /// deliberately not tighter: the minute-precision of each edge is carried by
        /// <c>DeviceGateTests.A_booking_code_opens_a_door_only_inside_its_own_bookings_window</c>
        /// against a threaded clock, and what this test is for is the AGREEMENT between two
        /// routes that each read <c>UtcNow</c> for themselves. They also have to be short enough
        /// not to overlap: one court, and the exclusion constraint is real here.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_door_accepts_a_booking_code_exactly_while_the_phone_would_show_it()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
            var device = factory.CreateClient();
            var mac = await GateAsync(factory, club, device, "front-door");
            var phone = MemberClient(factory, club);

            // Beyond the horizon: the phone will not show this booking's code at all.
            var far = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(140), minutes: 15);
            var farCode = await BookingCodeAsync(factory, club, far);

            var outOfReach = await GenerateAsync(phone);
            Assert.Equal("ident", outOfReach.GetProperty("kind").GetString());
            Assert.NotEqual(farCode, outOfReach.GetProperty("code").GetString());

            // …and the door agrees, to the same minute.
            await AssertRefusedAsync(device, Scan(club.Key, mac, farCode), GateAccess.TooEarly);

            // Inside it: the phone shows that booking's own code…
            var near = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(120), minutes: 15);
            var nearCode = await BookingCodeAsync(factory, club, near);

            var inReach = await GenerateAsync(phone);
            Assert.Equal("booking", inReach.GetProperty("kind").GetString());
            Assert.Equal(near.Id, inReach.GetProperty("booking_id").GetGuid());
            Assert.Equal(nearCode, inReach.GetProperty("code").GetString());

            // …and the door opens for exactly that code.
            Assert.True((await BodyAsync(await device.SendAsync(Scan(club.Key, mac, nearCode))))
                .GetProperty("opened").GetBoolean());
        }

        /// <summary>
        /// <b>The TOP edge, through both routes: the door is never narrower than the phone.</b>
        ///
        /// <para>
        /// The test above is the bottom edge; this is the other end, and the two are not
        /// symmetric. The phone stops offering a booking's code at <c>EndsAt</c>; the door goes on
        /// accepting it until the code itself expires, which is <c>EndsAt</c> plus the grace
        /// window. A member whose court has just finished is therefore still holding a code that
        /// works on the way out and back in — and, critically, so is a member the no-show sweep is
        /// about to write off, since the grace window is precisely how long the product waits
        /// before deciding somebody did not come.
        /// </para>
        ///
        /// <para>
        /// Narrower would be the product refusing a credential it minted and has not yet expired.
        /// The DIRECTION is what is asserted rather than the exact gap, because the gap is the
        /// club's own <c>grace_window_minutes</c>.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_door_still_opens_on_a_code_the_phone_has_stopped_offering()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
            var device = factory.CreateClient();
            var mac = await GateAsync(factory, club, device, "front-door");
            var phone = MemberClient(factory, club);

            // A court that ended two minutes ago, against a five-minute grace window.
            var over = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-17), minutes: 15);
            var code = await BookingCodeAsync(factory, club, over);

            // The phone has moved on: it offers an ident code, not this booking's.
            var screen = await GenerateAsync(phone);
            Assert.Equal("ident", screen.GetProperty("kind").GetString());
            Assert.NotEqual(code, screen.GetProperty("code").GetString());

            // The door has not. The code the club minted is still live, so it still opens.
            Assert.True((await BodyAsync(await device.SendAsync(Scan(club.Key, mac, code))))
                .GetProperty("opened").GetBoolean());
        }

        /// <summary>
        /// <b>The member's page cannot tell the truth about doors without being told.</b>
        ///
        /// <para>
        /// The Court Code screen says what the code in the member's hand will do, and since the
        /// gate shipped it has been wrong: a booking code also opens the club door, from
        /// `StartsAt − H` until shortly after the booking ends, and the page said nothing about
        /// it. The page cannot work that out for itself either — `H` is
        /// `max(gate_early_entry, min(roster + cue, 240))` under one policy and something else
        /// under the other, and the three settings behind it are not on a member's API surface
        /// and should not be. So the server, which already computes it for the door, says it.
        /// </para>
        ///
        /// <para>
        /// <c>doors</c> is separate from the two instants because it answers a different question:
        /// whether this club has doors at all. A club with none must have a page that says nothing
        /// about them rather than one saying "it opens the door" about a building with no
        /// controller in it.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_member_screen_is_told_what_its_code_does_at_a_door()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
            var device = factory.CreateClient();
            var phone = MemberClient(factory, club);

            // No gate row yet: the club has no doors, and the page must say nothing about them.
            var noDoors = await GenerateAsync(phone);
            Assert.False(noDoors.GetProperty("doors").GetBoolean());
            Assert.Equal(JsonValueKind.Null, noDoors.GetProperty("door_opens_at").ValueKind);
            Assert.Equal(JsonValueKind.Null, noDoors.GetProperty("door_closes_at").ValueKind);

            var mac = await GateAsync(factory, club, device, "front-door");

            // Still an ident code — no booking in reach — so the door instants stay null, because
            // a sixty-second ident code has no booking window of its own.
            var ident = await GenerateAsync(phone);
            Assert.Equal("ident", ident.GetProperty("kind").GetString());
            Assert.True(ident.GetProperty("doors").GetBoolean());
            Assert.Equal(JsonValueKind.Null, ident.GetProperty("door_opens_at").ValueKind);
            Assert.Equal(JsonValueKind.Null, ident.GetProperty("door_closes_at").ValueKind);

            // Now a booking inside the phone's horizon: the code becomes that booking's own, and
            // the two instants are the door's window for it.
            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(60));
            var screen = await GenerateAsync(phone);
            Assert.Equal("booking", screen.GetProperty("kind").GetString());
            Assert.True(screen.GetProperty("doors").GetBoolean());

            using var scope = factory.Services.CreateScope();

            // The tenant has to be set by hand: outside a request nothing has resolved one, and
            // the global query filter would then read every table as the empty tenant's — so the
            // code would resolve to nothing and the probe below would pass for the wrong reason.
            scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>()
                .Set(club.TenantId, club.Slug);

            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
            var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
            var live = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

            // Opens at StartsAt − H, and H is the DOOR's horizon: 130 minutes at these settings,
            // not the thirty-minute entry window. Asserted against the shared function over the
            // club's own live settings rather than against a literal, so the page and the door
            // cannot drift even in the test.
            var horizon = BookingCodeWindow.DoorHorizonMinutes(live);
            Assert.Equal(130, horizon);
            Assert.NotEqual(horizon, BookingCodeWindow.EntryWindowMinutes(live));

            Assert.Equal(
                booking.StartsAt.AddMinutes(-horizon),
                screen.GetProperty("door_opens_at").GetDateTimeOffset());

            // Closes when the CODE dies, which is the door's real upper edge — the slot's end plus
            // the grace window — and is deliberately later than the booking's own end.
            var closes = screen.GetProperty("door_closes_at").GetDateTimeOffset();
            Assert.Equal(booking.EndsAt.AddMinutes(live.GraceWindowMinutes), closes);
            Assert.True(closes > booking.EndsAt);

            // The probe: the code the page is showing really does open the door at
            // door_opens_at + a minute, and really does not a minute before it. One field, two
            // instants, and the door is asked rather than the arithmetic re-stated.
            var code = screen.GetProperty("code").GetString()!;
            var opensAt = screen.GetProperty("door_opens_at").GetDateTimeOffset();

            Assert.True((await GateAccess.DecideAsync(
                db, codes, new GateContext(row, live, "qr", code, opensAt.AddMinutes(1)), default)).Opened);
            Assert.Equal(GateAccess.TooEarly, (await GateAccess.DecideAsync(
                db, codes, new GateContext(row, live, "qr", code, opensAt.AddMinutes(-1)), default)).Reason);
        }

        /// <summary>
        /// A club whose only door is out of service has no doors as far as the member's page is
        /// concerned. The page's promise is "this will let you in", and a board the club has
        /// switched off will not — it is refused `403` on every route it calls.
        /// </summary>
        [SkippableFact]
        public async Task A_club_whose_only_door_is_out_of_service_has_no_doors_on_the_member_screen()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var device = factory.CreateClient();
            var phone = MemberClient(factory, club);
            var mac = await GateAsync(factory, club, device, "front-door");

            Assert.True((await GenerateAsync(phone)).GetProperty("doors").GetBoolean());

            var (gateId, _) = await IdsAsync(factory, mac, mac);
            var admin = await AdminClientAsync(factory, club);
            Assert.Equal(HttpStatusCode.OK,
                (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { enabled = false })).StatusCode);

            Assert.False((await GenerateAsync(phone)).GetProperty("doors").GetBoolean());

            // The probe: a COURT BOX is not a door. A club with boxes and no gates has no doors.
            await CourtBoxAsync(club, device);
            Assert.False((await GenerateAsync(phone)).GetProperty("doors").GetBoolean());
        }

        /// <summary>
        /// The four-hour ceiling over the wire, at a club whose own phone horizon is two days.
        ///
        /// <para>
        /// <c>roster_window_minutes</c> and <c>activation_cue_window_minutes</c> are both at the
        /// maximum the settings PUT allows, which is a settings document an admin can produce
        /// through the console without touching the database. Before the clamp that summed to
        /// 2880 minutes and every booking code in the building was a forty-eight-hour door key,
        /// while <c>GateAccess.MaxEarlyEntryMinutes</c>, this spec and the console all said four
        /// hours.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_door_reaches_four_hours_however_wide_the_clubs_own_horizon_is()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", TwoDayHorizonSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");

            var beyond = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(250), minutes: 15);
            await AssertRefusedAsync(
                client, Scan(club.Key, mac, await BookingCodeAsync(factory, club, beyond)), GateAccess.TooEarly);

            // …and inside the ceiling the same club's door opens, so the refusal above is the
            // ceiling and not a door that has stopped working.
            var inside = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(230), minutes: 15);
            Assert.True((await BodyAsync(await client.SendAsync(
                Scan(club.Key, mac, await BookingCodeAsync(factory, club, inside))))).GetProperty("opened").GetBoolean());
        }

        /// <summary>
        /// <b>The member walking back in for their next court, on the code from their last one.</b>
        ///
        /// <para>
        /// Over real Postgres rather than only against the in-memory provider, and that is not
        /// ceremony: the entitlement query bounds a booking by the slot it was SOLD —
        /// <c>StartsAt + SliceMinutes × SliceCount</c>, because the no-show sweep truncates
        /// <c>EndsAt</c> — and an expression the in-memory provider evaluates in C# is an
        /// expression Npgsql still has to translate to SQL. A query that throws at a door is
        /// indistinguishable from a door that does not work.
        /// </para>
        ///
        /// <para>
        /// The club runs a generous grace window, which is what keeps the earlier booking's code
        /// alive past its own slot: the row lives until <c>EndsAt</c> plus grace. That is the
        /// real shape of the complaint — a phone still showing the 17:00 QR at 18:50.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_spent_booking_code_opens_the_door_for_a_member_whose_next_court_is_due()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");

            // A court that ended ten minutes ago and has been promoted to `Completed` — which is
            // what `LightsCueWorker` does to an attended-and-over booking, so this is the shape a
            // member who PLAYED is left holding — and the next one starting in twenty. One court,
            // so they must not overlap: the exclusion constraint is real here. The code outlives
            // the promotion because nothing revokes one.
            var now = DateTimeOffset.UtcNow;
            var spentBooking = await BookAsync(factory, club, now.AddMinutes(-70), minutes: 60);
            var spent = await BookingCodeAsync(factory, club, spentBooking);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var row = await db.AccessCodes.IgnoreQueryFilters().SingleAsync(c => c.Code == spent);
                Assert.True(row.IsLiveAt(now), "the fixture must present a LIVE code, or this tests plain expiry");

                var played = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == spentBooking.Id);
                played.Status = BookingStatus.Completed;
                await db.SaveChangesAsync();
            }

            // Without the next booking the code is exactly as dead as it was.
            await AssertRefusedAsync(client, Scan(club.Key, mac, spent), GateAccess.NotRecognised);

            await BookAsync(factory, club, now.AddMinutes(20), minutes: 45);

            Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, spent))))
                .GetProperty("opened").GetBoolean());
        }
    }
}
