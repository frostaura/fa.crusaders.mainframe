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
    /// <summary>The admin's patch of a board and the device activity trail's reader.</summary>
    public sealed class AdminAndTrail(PostgresFixture pg) : DeviceGateHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- The admin surface ----------------------------------------------------

        /// <summary>
        /// <c>gate_key</c> is settable on a gate, trimmed, cleared by an empty string, refused on
        /// a court box, and refused past the column's width. <c>court_numbers</c> and
        /// <c>button_map</c> are refused on a gate rather than silently dropped, which is what
        /// they were before: a PATCH that reports success while changing nothing leaves the admin
        /// believing the courts are assigned and the row saying otherwise.
        /// </summary>
        [SkippableFact]
        public async Task The_admin_patch_holds_each_kind_to_its_own_fields()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var deviceClient = factory.CreateClient();
            var gateMac = await GateAsync(factory, club, deviceClient);
            var boxMac = NewMac();
            Assert.Equal(HttpStatusCode.OK, (await deviceClient.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);

            var (gateId, boxId) = await IdsAsync(factory, gateMac, boxMac);
            var admin = await AdminClientAsync(factory, club);

            // Trimmed on the way in.
            var named = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "  front-door  " });
            Assert.Equal(HttpStatusCode.OK, named.StatusCode);
            Assert.Equal("front-door", (await BodyAsync(named)).GetProperty("gate_key").GetString());

            // An empty string clears it; there is no third value to distinguish.
            var cleared = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "" });
            Assert.Equal(JsonValueKind.Null, (await BodyAsync(cleared)).GetProperty("gate_key").ValueKind);

            // Past the column's width, refused rather than truncated.
            var tooLong = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}",
                new { gate_key = new string('d', Device.GateKeyMaxLength + 1) });
            Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
            Assert.Equal(AdminDeviceEndpoints.GateKeyTooLong, (await BodyAsync(tooLong)).GetProperty("error").GetString());

            // A door's name on a court box.
            var wrongKind = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{boxId}", new { gate_key = "front-door" });
            Assert.Equal(HttpStatusCode.BadRequest, wrongKind.StatusCode);
            Assert.Equal(AdminDeviceEndpoints.GateKeyNotAGate, (await BodyAsync(wrongKind)).GetProperty("error").GetString());

            // Court fields on a door — including an explicit null button_map, which on a box is
            // the real instruction "run the club's map" and on a gate is as wrong as a list.
            foreach (var body in new object[]
            {
                new { court_numbers = new[] { 1 } },
                new { button_map = new[] { "court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60" } },
                new { button_map = (string[]?)null },
            })
            {
                var refused = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", body);
                Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
                Assert.Equal(AdminDeviceEndpoints.CourtFieldsOnAGate, (await BodyAsync(refused)).GetProperty("error").GetString());
            }

            // The name and the switch still work on a gate; refusing the court fields must not
            // have refused the row.
            var renamed = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { name = "Front door", enabled = false });
            Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
            Assert.Equal("Front door", (await BodyAsync(renamed)).GetProperty("name").GetString());
        }

        /// <summary>
        /// <b><c>gate_key</c> is two-valued, and both values are pinned here.</b> An explicit
        /// <c>null</c> — and an absent key, which binds to the same thing — means "leave the
        /// door's name alone"; <c>""</c> clears it. There is no third state, because a door either
        /// has a name or has not.
        ///
        /// <para>
        /// The clearing half has been pinned since the field shipped and the LEAVING-ALONE half
        /// had not been, which is the half a client gets wrong for free: send <c>null</c> meaning
        /// "clear it" and the API answers 200 having changed nothing, and nothing anywhere says
        /// so. Pinning both sides is what makes the console's choice of <c>""</c> a contract
        /// rather than a coincidence.
        /// </para>
        ///
        /// <para>
        /// The name is changed by a PATCH that also carries <c>name</c>, so the request is one the
        /// server definitely acted on — a null <c>gate_key</c> surviving an otherwise empty PATCH
        /// would prove nothing.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_null_gate_key_leaves_the_door_named_and_an_empty_string_clears_it()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var deviceClient = factory.CreateClient();
            var gateMac = await GateAsync(factory, club, deviceClient, "front-door");
            var (gateId, _) = await IdsAsync(factory, gateMac, gateMac);
            var admin = await AdminClientAsync(factory, club);

            // An explicit null, on a PATCH that definitely did something else.
            var renamed = await admin.PatchAsJsonAsync(
                $"/api/v1/admin/devices/{gateId}", new { name = "Front door", gate_key = (string?)null });
            Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);

            var body = await BodyAsync(renamed);
            Assert.Equal("Front door", body.GetProperty("name").GetString());
            Assert.Equal("front-door", body.GetProperty("gate_key").GetString());

            // An absent key is the same instruction.
            var untouched = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { name = "Side door" });
            Assert.Equal("front-door", (await BodyAsync(untouched)).GetProperty("gate_key").GetString());

            // …and the empty string is the one that clears it, which is what the console sends.
            var cleared = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "" });
            Assert.Equal(JsonValueKind.Null, (await BodyAsync(cleared)).GetProperty("gate_key").ValueKind);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Null((await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).GateKey);
        }

        /// <summary>
        /// <b>The silent no-op the spec itself argues against, on the PATCH this time.</b>
        ///
        /// <para>
        /// §8's settings PUT binds both spellings for exactly this reason: the endpoint answers
        /// snake_case and .NET binds camelCase, so the cost of a client picking the wrong one is
        /// not an error — it is <c>null</c>, which <c>gate_key</c> reads as "omitted, leave
        /// unchanged", so the request answers <c>200</c> with the door's old name in the body and
        /// nothing anywhere says the write was dropped. That argument was made in this document
        /// and then not applied to the one field on the PATCH that carries it.
        /// </para>
        ///
        /// <para>
        /// Both refusals still fire under either spelling, because a spelling is not a way round a
        /// rule: a camelCase <c>gateKey</c> on a court box is still <c>gate_key_not_a_gate</c>,
        /// and one past 64 characters is still <c>gate_key_too_long</c>.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_admin_patch_binds_gate_key_under_either_spelling()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var deviceClient = factory.CreateClient();
            var gateMac = await GateAsync(factory, club, deviceClient, "front-door");
            var boxMac = await CourtBoxAsync(club, deviceClient);
            var (gateId, boxId) = await IdsAsync(factory, gateMac, boxMac);
            var admin = await AdminClientAsync(factory, club);

            var camel = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gateKey = "side-door" });
            Assert.Equal(HttpStatusCode.OK, camel.StatusCode);
            Assert.Equal("side-door", (await BodyAsync(camel)).GetProperty("gate_key").GetString());

            // The empty string clears under the camelCase spelling too — the console's own
            // gesture must not depend on which of the two it happens to send.
            var cleared = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gateKey = "" });
            Assert.Equal(JsonValueKind.Null, (await BodyAsync(cleared)).GetProperty("gate_key").ValueKind);

            // Absent under BOTH spellings still means "leave it alone".
            await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gateKey = "back-door" });
            var untouched = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { name = "Back door" });
            Assert.Equal("back-door", (await BodyAsync(untouched)).GetProperty("gate_key").GetString());

            // And neither refusal can be stepped around by respelling the field.
            var onABox = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{boxId}", new { gateKey = "front-door" });
            Assert.Equal(HttpStatusCode.BadRequest, onABox.StatusCode);
            Assert.Equal(
                AdminDeviceEndpoints.GateKeyNotAGate, (await BodyAsync(onABox)).GetProperty("error").GetString());

            var tooLong = await admin.PatchAsJsonAsync(
                $"/api/v1/admin/devices/{gateId}", new { gateKey = new string('g', Device.GateKeyMaxLength + 1) });
            Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
            Assert.Equal(
                AdminDeviceEndpoints.GateKeyTooLong, (await BodyAsync(tooLong)).GetProperty("error").GetString());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal("back-door", (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).GateKey);
        }

        /// <summary>
        /// <c>kind</c> is not editable at all. A row that could change kind would keep a court
        /// list it can no longer use, or acquire one it never had; deleting the row and letting
        /// the board re-register is the reset.
        /// </summary>
        [SkippableFact]
        public async Task A_patch_cannot_change_a_boards_kind()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var deviceClient = factory.CreateClient();
            var gateMac = await GateAsync(factory, club, deviceClient);
            var (gateId, _) = await IdsAsync(factory, gateMac, gateMac);
            var admin = await AdminClientAsync(factory, club);

            var response = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { kind = "CourtBox", name = "Nice try" });

            // The unknown field is ignored by the binder, so the PATCH succeeds — and the kind
            // is exactly what it was. Asserting the ROW rather than the status is the point: a
            // 200 here does not mean nothing changed.
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("Gate", (await BodyAsync(response)).GetProperty("kind").GetString());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(DeviceKind.Gate, (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).Kind);
        }

        // ---- The trail's reader (B5) ---------------------------------------------

        /// <summary>
        /// <b>The door's trail had no reader, and the trail is the ENTIRE record a door leaves.</b>
        ///
        /// <para>
        /// §5 argues at length that the audit row matters more than a court box's equivalent
        /// because there is no ledger entry, no booking and no receipt to reconstruct an open
        /// from — and then no API route read <c>audit_log</c> at all. "Nobody could get in through
        /// the side door all Tuesday" was a question the spec promised an answer to and the
        /// product could only answer with a database client.
        /// </para>
        ///
        /// <para>
        /// One test over one board's whole day, because the value of this route is that the
        /// ONLINE and OFFLINE halves of a door's life appear in one list: an open, a refusal with
        /// its reason, and an open the board decided for itself while the link was down. The
        /// ordering is newest-first and is asserted rather than assumed, because a console that
        /// pages this will show the first page and nothing else.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_doors_activity_is_readable_and_carries_both_halves_of_its_day()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");

            // Online: one open, and one refusal with a reason.
            var ident = await IdentCodeAsync(factory, club.TenantId, club.MemberId);
            Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, ident)))).GetProperty("opened").GetBoolean());
            Assert.False((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, "ZZZZZZZZZZZZ")))).GetProperty("opened").GetBoolean());

            // Offline: an open the board decided from its cache while the link was down.
            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
            var bookingCode = await BookingCodeAsync(factory, club, booking);
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(DoorEvent(61, DeviceEventEndpoints.GateOpenKind, bookingCode)),
            }))).StatusCode);

            var (gateId, _) = await IdsAsync(factory, mac, mac);
            var admin = await AdminClientAsync(factory, club);

            var response = await admin.GetAsync($"/api/v1/admin/devices/{gateId}/activity");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await BodyAsync(response);
            var items = body.GetProperty("items").EnumerateArray().ToList();

            // Newest first — by when the CLUB heard about it, which is the trail's own order and
            // the axis the keyset cursor is total over. An offline row's `at` is the scan, which
            // is older than its delivery by the length of the outage, so the two axes are not the
            // same list and the feed is explicit about which one it is sorted on (A4).
            var delivered = items
                .Select(i => i.GetProperty("delivered_at").ValueKind == JsonValueKind.Null
                    ? i.GetProperty("at").GetDateTimeOffset()
                    : i.GetProperty("delivered_at").GetDateTimeOffset())
                .ToList();
            Assert.Equal(delivered.OrderByDescending(t => t), delivered);

            var open = Assert.Single(items, i => i.GetProperty("action").GetString() == DeviceGateEndpoint.OpenedAction);
            Assert.Equal(GateAccess.Ok, open.GetProperty("reason").GetString());
            Assert.False(open.GetProperty("offline").GetBoolean());
            Assert.Equal(club.MemberId, open.GetProperty("member").GetProperty("id").GetGuid());
            Assert.Equal("Gate Member", open.GetProperty("member").GetProperty("name").GetString());

            // An unreadable code names nobody, which is the whole of what the desk learns from it.
            var denied = Assert.Single(
                items, i => i.GetProperty("action").GetString() == $"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.NotRecognised}");
            Assert.Equal(GateAccess.NotRecognised, denied.GetProperty("reason").GetString());
            Assert.Equal(JsonValueKind.Null, denied.GetProperty("member").ValueKind);
            Assert.False(denied.GetProperty("offline").GetBoolean());

            var offline = Assert.Single(
                items, i => i.GetProperty("action").GetString() == $"device.{DeviceEventEndpoints.GateOpenKind}");
            Assert.True(offline.GetProperty("offline").GetBoolean());
            Assert.Equal(club.MemberId, offline.GetProperty("member").GetProperty("id").GetGuid());
            Assert.Matches("^[0-9a-f]{8}$", offline.GetProperty("fingerprint").GetString());

            // The online rows carry no fingerprint, because the online path never stored the
            // token in any form — see §5.
            Assert.Equal(JsonValueKind.Null, open.GetProperty("fingerprint").ValueKind);

            // The row the board's own registration wrote is here too — this is the BOARD's trail,
            // not a door-opens-only feed, and "when did this door first call in" is the same
            // question. It is in `events` and NOT in `items`, which is the C4 / B1 rule: a console
            // renders a row it has no chip for through whatever branch is last, so a registration
            // or an admin edit left among the scans was painted as a green "Refused".
            Assert.DoesNotContain(items, i => i.GetProperty("action").GetString() == "device.auto_registered");
            var events = body.GetProperty("events").EnumerateArray().ToList();
            var registered = Assert.Single(
                events, e => e.GetProperty("action").GetString() == "device.auto_registered");
            Assert.Equal(DoorAuditActions.RegisteredKind, registered.GetProperty("kind").GetString());
        }

        /// <summary>
        /// <b>The route must not become a second way to read a token.</b>
        ///
        /// <para>
        /// Two separate hazards. <c>DetailsJson</c> is never returned raw — it carries the club's
        /// device id, the gate key and, for a court box, the relay and booking — and the
        /// <c>fingerprint</c> field is validated to BE a fingerprint rather than trusted to be
        /// one. That second half is not theoretical: rows written before the fingerprint existed
        /// hold the live access code in <c>subject</c> in full, `RetentionWorker` never touches
        /// `DetailsJson`, and a reader that simply forwarded the field would have published every
        /// one of them to the console the day it shipped.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_activity_route_returns_no_raw_details_and_no_legacy_token()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");
            var (gateId, _) = await IdsAsync(factory, mac, mac);

            // Two rows exactly as the product wrote them before G2's B4, injected directly
            // because no code path produces them any more. The first is the token in full. The
            // second is the probe the first cannot be: twelve LOWERCASE HEX characters — the shape
            // of a MAC address, which is a plausible thing for some other writer to have put in
            // this field — which passes a character check and fails a length one. Without both,
            // half the guard is untested and a mutant that drops the length check survives.
            const string LegacyToken = "7Q3F9KM2XZ8B";
            const string HexShapedSubject = "0a1b2c3d4e5f";
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                foreach (var subject in new[] { LegacyToken, HexShapedSubject })
                {
                    db.AuditLogs.Add(new AuditLog
                    {
                        TenantId = club.TenantId,
                        ActorUserId = Guid.Empty,
                        Action = $"device.{DeviceEventEndpoints.UnknownScanKind}",
                        DetailsJson = JsonSerializer.Serialize(new
                        {
                            device_id = gateId,
                            device_code = "gate-legacy",
                            seq = 4L,
                            kind = DeviceEventEndpoints.UnknownScanKind,
                            subject,
                        }),
                    });
                }
                await db.SaveChangesAsync();
            }

            var admin = await AdminClientAsync(factory, club);
            var raw = await (await admin.GetAsync($"/api/v1/admin/devices/{gateId}/activity")).Content.ReadAsStringAsync();

            Assert.DoesNotContain(LegacyToken, raw, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(HexShapedSubject, raw, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("details", raw, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("gate_key", raw, StringComparison.OrdinalIgnoreCase);

            // Both rows are still listed — they are evidence — with their fingerprint field null,
            // because what they hold is not one.
            var legacy = JsonDocument.Parse(raw).RootElement.GetProperty("items").EnumerateArray()
                .Where(i => i.GetProperty("action").GetString() == $"device.{DeviceEventEndpoints.UnknownScanKind}")
                .ToList();
            Assert.Equal(2, legacy.Count);
            Assert.All(legacy, i => Assert.Equal(JsonValueKind.Null, i.GetProperty("fingerprint").ValueKind));
            Assert.All(legacy, i => Assert.True(i.GetProperty("offline").GetBoolean()));
        }

        /// <summary>
        /// <b>The cross-tenant injection this route needs, and it is not the 404 above.</b>
        ///
        /// <para>
        /// The device lookup being tenant-filtered stops an admin naming another club's board, and
        /// that is pinned separately. This pins the SECOND filter: the audit query itself. Rows are
        /// attributed to a board by a <c>device_id</c> inside a jsonb document with no foreign key
        /// behind it, so if that query ever lost its tenant filter, any row anywhere carrying this
        /// id would be served — and the id is the only thing being matched on.
        /// </para>
        ///
        /// <para>
        /// The row is injected rather than produced, because no code path writes another tenant's
        /// device id into this tenant's details and none should. That is what a cross-tenant
        /// injection test is for, and this repository requires one on every change touching a
        /// tenant-scoped table.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task Another_clubs_audit_rows_never_appear_in_this_clubs_device_activity()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var mine = await ClubAsync(factory, "gate", DefaultSettings);
            var theirs = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, mine, client, "front-door");
            var (gateId, _) = await IdsAsync(factory, mac, mac);

            const string TheirAction = "device.their_private_business";
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.AuditLogs.Add(new AuditLog
                {
                    TenantId = theirs.TenantId,
                    ActorUserId = Guid.Empty,
                    SubjectUserId = theirs.MemberId,
                    Action = TheirAction,
                    DetailsJson = JsonSerializer.Serialize(new { device_id = gateId, seq = 1L }),
                });
                await db.SaveChangesAsync();
            }

            var raw = await (await (await AdminClientAsync(factory, mine))
                .GetAsync($"/api/v1/admin/devices/{gateId}/activity")).Content.ReadAsStringAsync();

            Assert.DoesNotContain(TheirAction, raw, StringComparison.Ordinal);
            Assert.DoesNotContain(theirs.MemberId.ToString(), raw, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// The limit is clamped rather than refused, and defaults to fifty. A console asking for
        /// a million rows is a mistake to bound, not a request to fail — and a console asking for
        /// none of them is asking for nothing useful.
        /// </summary>
        [SkippableTheory]
        [InlineData(null, 50)]
        [InlineData(1, 1)]
        [InlineData(3, 3)]
        [InlineData(0, 1)]
        [InlineData(-9, 1)]
        // Fifty-nine refusals are scans; the registration row is a door EVENT and is on the other
        // array, so the scan page tops out at 59 rather than 60. See AdminDeviceActivityEndpoint.
        [InlineData(200, 59)]
        [InlineData(10_000, 59)]
        public async Task The_activity_limit_is_clamped_and_defaults_to_fifty(int? limit, int expected)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");
            var (gateId, _) = await IdsAsync(factory, mac, mac);

            // Sixty rows: past the default page and short of the maximum, so both the "clamped
            // down to the page" and "clamped up to what exists" cases are real.
            for (var i = 0; i < 59; i++)
            {
                await client.SendAsync(Scan(club.Key, mac, "ZZZZZZZZZZZZ"));
            }

            var query = limit is null ? "" : $"?limit={limit}";
            var response = await (await AdminClientAsync(factory, club)).GetAsync(
                $"/api/v1/admin/devices/{gateId}/activity{query}");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(expected, (await BodyAsync(response)).GetProperty("items").GetArrayLength());
        }

        /// <summary>
        /// Another club's board is not this club's to read, and the answer is a 404 rather than a
        /// 403: whether a device id exists at all is itself a fact about the other tenant.
        /// </summary>
        [SkippableFact]
        public async Task Another_clubs_device_has_no_activity_here()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var mine = await ClubAsync(factory, "gate", DefaultSettings);
            var theirs = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();

            var theirMac = await GateAsync(factory, theirs, client, "their-door");
            var (theirGateId, _) = await IdsAsync(factory, theirMac, theirMac);
            await client.SendAsync(Scan(theirs.Key, theirMac, await IdentCodeAsync(factory, theirs.TenantId, theirs.MemberId)));

            var admin = await AdminClientAsync(factory, mine);
            Assert.Equal(
                HttpStatusCode.NotFound,
                (await admin.GetAsync($"/api/v1/admin/devices/{theirGateId}/activity")).StatusCode);

            // And their admin can read it, so the refusal above is tenancy and not a broken route.
            var theirAdmin = await AdminClientAsync(factory, theirs);
            var theirs200 = await theirAdmin.GetAsync($"/api/v1/admin/devices/{theirGateId}/activity");
            Assert.Equal(HttpStatusCode.OK, theirs200.StatusCode);
            Assert.NotEmpty((await BodyAsync(theirs200)).GetProperty("items").EnumerateArray());
        }

        /// <summary>
        /// A court box has the same route and the same shape. Its trail is not a door's — it is
        /// activations, releases and the outcomes they settled — but "what has this board been
        /// doing" is one question and the console asks it from one place.
        /// </summary>
        [SkippableFact]
        public async Task A_court_boxs_activity_is_readable_on_the_same_route()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var boxMac = await CourtBoxAsync(club, client);
            var (boxId, _) = await IdsAsync(factory, boxMac, boxMac);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
            var token = await BookingCodeAsync(factory, club, booking);
            var activation = DoorEvent(71, DeviceEventEndpoints.ActivationKind, token);
            activation["court"] = 0;
            activation["uptime_ms"] = 3_599_000;
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = boxMac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(activation),
            }))).StatusCode);

            var response = await (await AdminClientAsync(factory, club)).GetAsync(
                $"/api/v1/admin/devices/{boxId}/activity");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var body = await BodyAsync(response);
            var items = body.GetProperty("items").EnumerateArray().ToList();
            var row = Assert.Single(items, i => i.GetProperty("action").GetString() == $"device.{DeviceEventEndpoints.ActivationKind}");
            Assert.True(row.GetProperty("offline").GetBoolean());
            Assert.Matches("^[0-9a-f]{8}$", row.GetProperty("fingerprint").GetString());
            Assert.Equal(ActivationOutcomeOk, row.GetProperty("reason").GetString());

            // The door split does not reach a box: `events` is present and empty, so the console
            // types one response shape, and the box's whole trail stays where its screen reads it.
            Assert.Empty(body.GetProperty("events").EnumerateArray());
            Assert.Contains(items, i => i.GetProperty("action").GetString() == "device.auto_registered");
        }
    }
}
