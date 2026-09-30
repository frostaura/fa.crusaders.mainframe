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
    /// <summary>What a gate may not do on the court-box routes, and door events a court box uploads.</summary>
    public sealed class CourtBoxRoutes(PostgresFixture pg) : DeviceGateHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- What a gate may not do on the court-box routes -----------------------

        /// <summary>
        /// <b>A door sells no court time and checks nobody in.</b> All four court-box paths
        /// refuse a gate row by name.
        ///
        /// <para>
        /// Every one of them already refused a gate by accident, because a gate has no court
        /// numbers: the activation path fails its relay-index check against an empty list and the
        /// walk-up fails <c>court_not_on_device</c>. Both are wrong sentences, and both stop being
        /// refusals at all the moment anybody puts a court number on a gate row — which is a
        /// single PATCH away. The rule is "a door never sells court time and never checks anyone
        /// in", and a rule enforced by the emptiness of an unrelated list is not enforced.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_gate_cannot_activate_a_court_or_sell_a_walk_up()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);
            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(2));

            var activate = await client.SendAsync(Signed(club.Key, "/api/v1/device/activate",
                new JsonObject { ["mac"] = mac, ["method"] = "qr", ["token"] = token }));
            Assert.Equal(HttpStatusCode.OK, activate.StatusCode);
            var activated = await BodyAsync(activate);
            Assert.False(activated.GetProperty("activated").GetBoolean());
            Assert.Equal(GateAccess.NotACourtBox, activated.GetProperty("reason").GetString());
            Assert.Equal(0, activated.GetProperty("granted_seconds").GetInt32());

            var walkup = await client.SendAsync(Signed(club.Key, "/api/v1/device/walkup",
                new JsonObject
                {
                    ["mac"] = mac,
                    ["minutes"] = 30,
                    ["method"] = "qr",
                    ["token"] = token,
                    ["court"] = 1,
                    ["nonce"] = Guid.NewGuid().ToString("N")[..16],
                }));
            Assert.Equal(HttpStatusCode.BadRequest, walkup.StatusCode);
            Assert.Equal(GateAccess.NotACourtBox, (await BodyAsync(walkup)).GetProperty("error").GetString());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
            Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
        }

        /// <summary>
        /// An <c>activation</c> uploaded BY A GATE ROW is receipted and acknowledged — never
        /// 4xx'd, because an event a board cannot change is a board retrying for ever — and
        /// settles nothing: no <c>CheckedInAt</c>, no ledger row, and an audit row naming why.
        /// </summary>
        [SkippableFact]
        public async Task An_activation_uploaded_by_a_gate_is_recorded_and_settles_nothing()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);
            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
            var bookingCode = await BookingCodeAsync(factory, club, booking);

            var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 120000,
                ["events"] = new JsonArray(new JsonObject
                {
                    ["seq"] = 1,
                    ["uptime_ms"] = 60000,
                    ["kind"] = "activation",
                    ["court"] = 0,
                    ["method"] = "qr",
                    ["subject"] = bookingCode,
                    ["duration_ms"] = 2700000,
                }),
            }));

            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
            Assert.Equal(1, (await BodyAsync(upload)).GetProperty("accepted_through").GetInt64());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
            Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());

            var actions = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId).Select(a => a.Action).ToListAsync();
            Assert.Contains($"device.activation_{GateAccess.NotACourtBox}", actions);
        }

        /// <summary>
        /// An offline open: receipted, audited, and named. The subject is resolved at the scan's
        /// own time rather than the upload's, so a code that has since expired still identifies
        /// the member who held it up — the audit row is the ONLY record a door leaves, so an
        /// anonymous one answers nothing anybody will ask.
        /// </summary>
        [SkippableFact]
        public async Task An_offline_gate_open_is_receipted_and_names_the_member_without_checking_them_in()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);

            // A booking that ended an hour ago, and a code that died with it. Judged at the
            // upload clock it resolves to nobody; judged at the scan it names the member.
            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
            var bookingCode = await BookingCodeAsync(factory, club, booking);

            var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(new JsonObject
                {
                    ["seq"] = 9,
                    ["uptime_ms"] = 600_000,      // an hour before the upload
                    ["kind"] = DeviceEventEndpoints.GateOpenKind,
                    ["court"] = -1,
                    ["method"] = "qr",
                    ["subject"] = bookingCode,
                    ["duration_ms"] = 3000,
                }),
            }));

            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
            Assert.Equal(9, (await BodyAsync(upload)).GetProperty("accepted_through").GetInt64());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            var receipt = Assert.Single(await db.DeviceEventReceipts.IgnoreQueryFilters()
                .Where(r => r.TenantId == club.TenantId).ToListAsync());
            Assert.Equal(DeviceEventEndpoints.GateOpenKind, receipt.Kind);

            // -1 is the wire's "no relay", and a gate_open receipt must carry no booking either:
            // a later `release` pairs on (device, relay, booking) and would otherwise re-price a
            // court from a doorway.
            Assert.Null(receipt.Court);
            Assert.Null(receipt.BookingId);

            var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}")
                .ToListAsync());
            Assert.Equal(club.MemberId, audit.SubjectUserId);

            // One row, not two: the outcome is `ok`, so there is no device.gate_open_<code> row.
            Assert.Empty(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.gate_open_")).ToListAsync());

            // And nothing was settled.
            Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
            Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
        }

        /// <summary>
        /// <b>The offline trail must not carry the code itself.</b>
        ///
        /// <para>
        /// §5 leaves the token out of <c>gate.opened</c> on purpose — a live access code in a
        /// trail an admin can read is a credential in a log — and the OFFLINE path wrote it in
        /// full, under <c>subject</c>, for a <c>gate_open</c> and an <c>unknown_scan</c> alike.
        /// Those are the bytes the member held up at the door: they open every door in the club
        /// for the length of that booking's window, and <c>RetentionWorker</c> anonymises a row's
        /// SUBJECT while never touching its <c>DetailsJson</c>, so they stayed readable for as
        /// long as the row did.
        /// </para>
        ///
        /// <para>
        /// A fingerprint rather than nothing, because the field was worth something: two scans of
        /// one code still correlate, so "the same badge tried the side door eleven times" remains
        /// answerable. The identity lives on <c>SubjectUserId</c>, which is asserted here too so
        /// the fix cannot be read as having thrown the identity away with the token.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(DeviceEventEndpoints.GateOpenKind)]
        [InlineData(DeviceEventEndpoints.UnknownScanKind)]
        public async Task An_offline_door_event_fingerprints_the_token_instead_of_logging_it(string kind)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
            var token = await BookingCodeAsync(factory, club, booking);

            // The same code twice, so the correlation property is asserted rather than assumed.
            var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(
                    DoorEvent(11, kind, token), DoorEvent(12, kind, token)),
            }));
            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var rows = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{kind}")
                .ToListAsync();
            Assert.Equal(2, rows.Count);

            var fingerprints = new List<string>();
            foreach (var row in rows)
            {
                Assert.DoesNotContain(token, row.DetailsJson, StringComparison.OrdinalIgnoreCase);

                var subject = JsonDocument.Parse(row.DetailsJson!).RootElement.GetProperty("subject").GetString()!;
                Assert.Equal(8, subject.Length);
                Assert.DoesNotContain(subject, token, StringComparison.OrdinalIgnoreCase);
                fingerprints.Add(subject);
            }

            // Two scans of one code still correlate, which is the only reason to keep the field.
            Assert.Equal(fingerprints[0], fingerprints[1]);

            // …and a DIFFERENT code fingerprints differently, so the field still discriminates.
            var other = await BookingCodeAsync(
                factory, club, await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-200)));
            await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(DoorEvent(13, kind, other)),
            }));

            var third = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{kind}")
                .OrderBy(a => a.CreatedAt).ToListAsync();
            Assert.Equal(3, third.Count);
            Assert.DoesNotContain(
                JsonDocument.Parse(third[^1].DetailsJson!).RootElement.GetProperty("subject").GetString(),
                fingerprints);

            // The identity was not thrown away with the token: a resolvable gate_open still names
            // its member on the row itself.
            if (kind == DeviceEventEndpoints.GateOpenKind) Assert.Equal(club.MemberId, rows[0].SubjectUserId);
        }

        /// <summary>
        /// The second half of the same bypass, stated as the refusal it defeats: a COURT BOX
        /// posting a door open must be told <c>not_a_gate</c> whatever spelling it uses.
        ///
        /// <para>
        /// The guard exists because the row this writes NAMES A MEMBER, and a false record of who
        /// was in the building is a worse artefact than a refusal. A guard a sender can step
        /// around by shouting is not a guard.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(" gate_open ")]
        [InlineData("GATE_OPEN")]
        public async Task A_court_box_cannot_post_a_door_open_by_respelling_the_kind(string spelling)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var boxMac = await CourtBoxAsync(club, client);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
            var token = await BookingCodeAsync(factory, club, booking);

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = boxMac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(DoorEvent(31, spelling, token)),
            }))).StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var rows = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.gate_open")).ToListAsync();

            // The refusal is recorded, and the row names nobody.
            Assert.Contains(rows, a => a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}_{GateAccess.NotAGate}");
            Assert.All(rows, a => Assert.Null(a.SubjectUserId));
            Assert.All(rows, a => Assert.DoesNotContain(token, a.DetailsJson, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>
        /// <b>A court box's own <c>activation</c> token is a door key too, and the trail wrote it
        /// in full.</b>
        ///
        /// <para>
        /// The G2 fix narrowed the fingerprint to the two DOOR kinds and said so in as many words:
        /// a court box's activation token "is the roster token for a booking the receipt already
        /// names, and narrowing it is a separate decision about the court-box trail". That
        /// reasoning was true when it was written and stopped being true the moment the gate
        /// shipped — since D2, that same roster token opens <b>every door in the club</b> for the
        /// length of its booking's window. The receipt naming the booking does not make the bytes
        /// less live.
        /// </para>
        ///
        /// <para>
        /// So the fingerprint is now unconditional. Resolution still uses the raw subject, in
        /// memory, where it never reaches a row: this asserts the activation was really applied —
        /// <c>CheckedInAt</c> stamped — so the fix cannot be read as having broken attendance to
        /// hide a token.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_court_boxs_activation_event_fingerprints_its_token_as_well()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var boxMac = await CourtBoxAsync(club, client);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
            var token = await BookingCodeAsync(factory, club, booking);

            var activation = DoorEvent(41, DeviceEventEndpoints.ActivationKind, token);
            activation["court"] = 0;            // relay A, which this box drives for court 1
            activation["uptime_ms"] = 3_599_000; // a second before the upload, so the scan is inside the cue window

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = boxMac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(activation),
            }))).StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            // The control: the activation really was applied, so this is a fingerprint over a
            // token the handler resolved rather than one it failed to.
            Assert.NotNull((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);

            var rows = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.activation")).ToListAsync();
            Assert.NotEmpty(rows);
            Assert.All(rows, a => Assert.DoesNotContain(token, a.DetailsJson, StringComparison.OrdinalIgnoreCase));
            Assert.All(rows, a => Assert.Equal(
                8, JsonDocument.Parse(a.DetailsJson!).RootElement.GetProperty("subject").GetString()!.Length));
        }

        /// <summary>
        /// <b>The mirror of <c>not_a_court_box</c>, and it was missing.</b> A <c>gate_open</c>
        /// uploaded by a COURT BOX row is receipted and acknowledged like any other event the
        /// board cannot change, but its outcome is <c>not_a_gate</c> and its audit row names
        /// nobody.
        ///
        /// <para>
        /// The activation and release kinds have been guarded by the board's kind since the gate
        /// landed; <c>gate_open</c> had no such guard, so a court box — or anything else holding
        /// the club key with a box's MAC — could post an arbitrary access code and have the server
        /// write <c>device.gate_open</c> naming whoever that code identified. Nothing settles on
        /// that row, so no money moved; what it produced was a door-opening record, attributed to
        /// a member, for a door that does not exist.
        /// </para>
        ///
        /// <para>
        /// Both boards are driven here with the SAME event and the SAME code, which is what makes
        /// the assertion discriminate: one names the member and one does not, so a fix that simply
        /// stopped naming anybody would fail the gate half.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_gate_open_uploaded_by_a_court_box_names_nobody_and_says_not_a_gate()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();

            var gateMac = await GateAsync(factory, club, client);
            var boxMac = NewMac();
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
            var bookingCode = await BookingCodeAsync(factory, club, booking);

            var atGate = await client.SendAsync(Signed(club.Key, EventsPath, GateOpenBatch(gateMac, bookingCode, 11)));
            var atBox = await client.SendAsync(Signed(club.Key, EventsPath, GateOpenBatch(boxMac, bookingCode, 12)));

            // Acknowledged on both, because an event a board cannot change is a board retrying
            // for ever — the refusal is in the outcome, never in the status.
            Assert.Equal(HttpStatusCode.OK, atGate.StatusCode);
            Assert.Equal(HttpStatusCode.OK, atBox.StatusCode);
            Assert.Equal(12, (await BodyAsync(atBox)).GetProperty("accepted_through").GetInt64());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var (gateId, boxId) = await IdsAsync(factory, gateMac, boxMac);

            var rows = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.gate_open"))
                .ToListAsync();

            // The gate's open is the control: same code, same instant, and it DOES name the member.
            var fromGate = Assert.Single(rows, a =>
                a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}" && Names(a, gateId));
            Assert.Equal(club.MemberId, fromGate.SubjectUserId);

            var fromBox = Assert.Single(rows, a =>
                a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}" && Names(a, boxId));
            Assert.Null(fromBox.SubjectUserId);

            // …and the refusal is named, exactly as an activation from a gate is.
            var refusal = Assert.Single(rows, a =>
                a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}_{GateAccess.NotAGate}");
            Assert.True(Names(refusal, boxId), "the not_a_gate row must belong to the court box");
            Assert.Null(refusal.SubjectUserId);

            // A receipt each, and nothing settled by either.
            Assert.Equal(2, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.TenantId == club.TenantId));
            Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
            Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
        }

        /// <summary>A gate_open whose token resolves to nobody is still recorded — the door still opened.</summary>
        [SkippableFact]
        public async Task An_offline_gate_open_with_an_unresolvable_token_is_still_recorded()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);

            var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 120000,
                ["events"] = new JsonArray(new JsonObject
                {
                    ["seq"] = 3,
                    ["uptime_ms"] = 60000,
                    ["kind"] = DeviceEventEndpoints.GateOpenKind,
                    ["court"] = -1,
                    ["method"] = "qr",
                    ["subject"] = "ZZZZZZZZZZZZ",
                    ["duration_ms"] = 3000,
                }),
            }));

            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}")
                .ToListAsync());
            Assert.Null(audit.SubjectUserId);
        }
    }
}
