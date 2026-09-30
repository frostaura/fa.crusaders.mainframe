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
    /// <summary>A scan at the door: who opens it, how every refusal is answered and audited, and what another club cannot do.</summary>
    public sealed class DoorScans(PostgresFixture pg) : DeviceGateHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- The scan ------------------------------------------------------------

        /// <summary>
        /// The happy path over the wire, and the audit row that is the entire record a door
        /// leaves behind — there is no ledger entry and no booking to reconstruct it from.
        /// </summary>
        [SkippableFact]
        public async Task An_active_member_opens_the_door_and_the_open_is_audited()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

            var response = await client.SendAsync(Scan(club.Key, mac, token));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var json = await BodyAsync(response);
            Assert.True(json.GetProperty("opened").GetBoolean());
            Assert.Equal(GateAccess.Ok, json.GetProperty("reason").GetString());
            Assert.Equal(TenantSettingsView.DefaultGateUnlockSeconds, json.GetProperty("unlock_seconds").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action == DeviceGateEndpoint.OpenedAction).ToListAsync());

            Assert.Equal(club.MemberId, audit.SubjectUserId);
            Assert.Equal(Guid.Empty, audit.ActorUserId);
            Assert.Contains("front-door", audit.DetailsJson!, StringComparison.Ordinal);

            // The token is deliberately NOT in the details: a live access code in a trail an
            // admin can read is a credential in a log.
            Assert.DoesNotContain(token, audit.DetailsJson!, StringComparison.Ordinal);

            // A door moves no money and stamps no attendance, over HTTP as in the unit tests.
            Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
        }

        /// <summary>
        /// <b>Every refusal is a 200.</b> The firmware falls back to its cached roster on
        /// anything that is not a clean 200, because that means the server could not be reached
        /// or could not answer — so a 403 for a suspended member would make the gate treat a
        /// decision the server definitely made as an outage, second-guess it against a roster
        /// fetched minutes ago, and let in whoever the club had just suspended.
        /// </summary>
        [SkippableFact]
        public async Task Every_refusal_is_a_200_the_firmware_can_act_on_and_is_audited_by_reason()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "side-door");
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

            // not_recognised
            await AssertRefusedAsync(client, Scan(club.Key, mac, "ZZZZZZZZZZZZ"), GateAccess.NotRecognised);

            // method_not_supported
            await AssertRefusedAsync(client, Scan(club.Key, mac, token, "pin"), GateAccess.MethodNotSupported);

            // not_a_gate — the same scan at a court box's MAC
            var boxMac = NewMac();
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);
            await AssertRefusedAsync(client, Scan(club.Key, boxMac, token), GateAccess.NotAGate);

            // member_not_active — the control above proves the same token opens the door while
            // the membership is Active, so this varies exactly one field.
            Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());
            await SuspendAsync(factory, club);
            await AssertRefusedAsync(client, Scan(club.Key, mac, token), GateAccess.MemberNotActive);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var actions = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith(DeviceGateEndpoint.DeniedActionPrefix))
                .Select(a => a.Action).ToListAsync();

            Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.NotRecognised}", actions);
            Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.MethodNotSupported}", actions);
            Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.NotAGate}", actions);
            Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.MemberNotActive}", actions);
        }

        /// <summary>
        /// The board identity failures are the same three shapes as every other device route —
        /// a malformed MAC is a 400, an unknown one a 404, a disabled board a 403 — and they are
        /// deliberately NOT the 200 a decision gets, because none of them is a decision.
        /// </summary>
        [SkippableFact]
        public async Task The_board_identity_failures_keep_their_own_shapes()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

            Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Scan(club.Key, "not-a-mac", token))).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Scan(club.Key, NewMac(), token))).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Scan(DeviceApiKey.Generate(), mac, token))).StatusCode);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
                device.Enabled = false;
                await db.SaveChangesAsync();
            }

            Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Scan(club.Key, mac, token))).StatusCode);
        }

        /// <summary>
        /// <b>A board an admin has taken out of service is 403 on the heartbeat as well as on the
        /// scan</b>, which is what makes 403 authoritative for a gate: the firmware treats it as
        /// "the club has withdrawn this board" and denies the scan outright rather than falling
        /// back to its roster, and a 403 on the heartbeat commits an empty roster.
        ///
        /// <para>
        /// It is worth its own pin because it is the one refusal a gate must NOT recover from.
        /// Every other failure — a timeout, a 401, a 404, a 5xx, a malformed 200 — means the
        /// server could not be reached or could not answer, and the board is right to fall back.
        /// A 403 is the club speaking.
        /// </para>
        ///
        /// <para>
        /// <b>And the residual is real, so it is stated rather than implied:</b> this only reaches
        /// a board that can still reach us. A gate that has been cut off entirely never hears the
        /// 403 and goes on admitting whatever its cached roster still carries, for up to the six
        /// hours until that roster goes stale. Taking a door out of service is not the same as
        /// locking it.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_gate_taken_out_of_service_is_refused_on_the_heartbeat_too()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

            // The control: in service, both routes answer.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate))).StatusCode);
            Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());

            var (gateId, _) = await IdsAsync(factory, mac, mac);
            var admin = await AdminClientAsync(factory, club);
            Assert.Equal(HttpStatusCode.OK,
                (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { enabled = false })).StatusCode);

            Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Scan(club.Key, mac, token))).StatusCode);

            // Not re-registered around the switch: the row is still there and still disabled, so
            // the board cannot get back in by pretending to be new.
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
            Assert.False(row.Enabled);
            Assert.NotNull(row.OutOfServiceSince);
        }

        /// <summary>
        /// <b>Tenant B's code at tenant A's gate is <c>not_recognised</c>.</b> The code is real,
        /// live, and in the same database — everything but the tenant matches — so the refusal
        /// is the query filter and not an empty table. Cross-tenant leakage here is somebody
        /// walking into another club's building.
        /// </summary>
        [SkippableFact]
        public async Task Another_clubs_code_does_not_open_this_clubs_door()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var alpha = await ClubAsync(factory, "alpha", DefaultSettings);
            var bravo = await ClubAsync(factory, "bravo", DefaultSettings);
            var client = factory.CreateClient();

            var alphaGate = await GateAsync(factory, alpha, client);
            var bravoGate = await GateAsync(factory, bravo, client);
            var bravoToken = await IdentCodeAsync(factory, bravo.TenantId, bravo.MemberId);

            // The control: it works at its own club. Without this the assertion below would hold
            // against an implementation that refuses everybody.
            Assert.True((await BodyAsync(await client.SendAsync(Scan(bravo.Key, bravoGate, bravoToken))))
                .GetProperty("opened").GetBoolean());

            await AssertRefusedAsync(client, Scan(alpha.Key, alphaGate, bravoToken), GateAccess.NotRecognised);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(bravo.TenantId,
                (await db.AccessCodes.IgnoreQueryFilters().SingleAsync(c => c.Code == bravoToken)).TenantId);

            // And nobody was named in alpha's audit row, because nothing resolved.
            var denial = await db.AuditLogs.IgnoreQueryFilters()
                .SingleAsync(a => a.TenantId == alpha.TenantId && a.Action.StartsWith(DeviceGateEndpoint.DeniedActionPrefix));
            Assert.Null(denial.SubjectUserId);
        }

        /// <summary>
        /// And tenant B's bookings never reach tenant A's gate roster — the same P0 class from
        /// the other direction, and the one that would push another club's live access codes to
        /// a board in this club's doorway.
        /// </summary>
        [SkippableFact]
        public async Task Another_clubs_bookings_never_reach_this_clubs_gate_roster()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var alpha = await ClubAsync(factory, "alpha", DefaultSettings);
            var bravo = await ClubAsync(factory, "bravo", DefaultSettings);
            var client = factory.CreateClient();

            // BOTH doors are named, and that is now part of the fixture rather than decoration:
            // an unnamed gate is pushed an empty roster whatever the club has booked, so a pair of
            // unnamed gates would make this pass for the wrong reason — the emptiness at alpha has
            // to be the tenant filter and not the naming rule.
            var alphaGate = await GateAsync(factory, alpha, client, "alpha-front");
            var bravoGate = await GateAsync(factory, bravo, client, "bravo-front");

            await BookAsync(factory, bravo, DateTimeOffset.UtcNow.AddMinutes(20));

            var atAlpha = await BodyAsync(await client.SendAsync(Heartbeat(alpha.Key, alphaGate, DeviceKinds.Gate)));
            Assert.Empty(atAlpha.GetProperty("roster").EnumerateArray());

            // Bravo's own gate has it, so the emptiness above is the filter rather than a
            // booking that was never pushed to anybody.
            var atBravo = await BodyAsync(await client.SendAsync(Heartbeat(bravo.Key, bravoGate, DeviceKinds.Gate)));
            Assert.Single(atBravo.GetProperty("roster").EnumerateArray());
        }

        /// <summary>
        /// The <c>booking_window</c> policy over the wire, and the one field that moves between
        /// the two halves is the club's policy string.
        /// </summary>
        [SkippableFact]
        public async Task The_booking_window_policy_refuses_a_member_with_nothing_booked()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate",
                """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","gate_access_policy":"booking_window","gate_early_entry_minutes":30}""");
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

            await AssertRefusedAsync(client, Scan(club.Key, mac, token), GateAccess.NoBooking);

            // Twenty minutes out is inside a thirty-minute entry window.
            await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));
            Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());
        }

        /// <summary>
        /// <b>Club admins always pass</b>, over the wire, holding an ordinary Active membership
        /// and nothing booked.
        ///
        /// <para>
        /// The exemption used to be keyed on having NO membership row, and no production path
        /// creates such an account — registration writes one and an admin promoted from the member
        /// roll keeps theirs. So the day a club switched to <c>booking_window</c> its own staff
        /// were locked out of the building, and the test that claimed otherwise passed only
        /// because it deleted the row first.
        /// </para>
        ///
        /// <para>
        /// The ordinary member on the same club, same policy, same instant is the probe: one
        /// field differs between the two scans and it is <c>IsAdmin</c>.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_club_admin_with_a_membership_and_no_booking_still_opens_the_door()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", BookingWindowSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);

            var adminId = await AdminUserAsync(factory, club);
            var adminToken = await IdentCodeAsync(factory, club.TenantId, adminId);
            var memberToken = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

            // The ordinary member, with the same Active membership and nothing booked, is out.
            await AssertRefusedAsync(client, Scan(club.Key, mac, memberToken), GateAccess.NoBooking);

            var opened = await BodyAsync(await client.SendAsync(Scan(club.Key, mac, adminToken)));
            Assert.True(opened.GetProperty("opened").GetBoolean(),
                "a club admin must not be locked out of the building by the booking_window policy");
            Assert.Equal(GateAccess.Ok, opened.GetProperty("reason").GetString());
        }

        /// <summary>
        /// The release is the club's setting, from the settings document through the decision to
        /// the wire. The same club with one number changed answers a different number.
        /// </summary>
        [SkippableFact]
        public async Task The_release_on_the_wire_is_the_clubs_setting()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate",
                """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"UTC","gate_unlock_seconds":12}""");
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

            Assert.Equal(12, (await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token))))
                .GetProperty("unlock_seconds").GetInt32());

            // …and the heartbeat tells the gate the same number, so what it does offline matches
            // what it would have been told online.
            Assert.Equal(12, (await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate))))
                .GetProperty("gate").GetProperty("unlock_seconds").GetInt32());
        }
    }
}
