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
    /// <summary>A board registers as a gate or a court box, the gate's roster, and the cap on boards nobody acknowledged.</summary>
    public sealed class Registration(PostgresFixture pg) : DeviceGateHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- Registration and the heartbeat --------------------------------------

        /// <summary>
        /// A board that says it is a gate becomes one, and gets a gate's answer: no court
        /// numbers, no relay config, no button map, and a <c>gate</c> block with the release the
        /// club configured. Every absence here is as much of the contract as the presences.
        /// </summary>
        [SkippableFact]
        public async Task A_board_that_calls_itself_a_gate_registers_as_one_and_gets_a_gates_heartbeat()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var mac = NewMac();
            var client = factory.CreateClient();

            var json = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));

            Assert.Equal(club.Slug, json.GetProperty("tenant_slug").GetString());
            Assert.Equal($"gate-{mac[^6..]}", json.GetProperty("device_code").GetString());
            Assert.Equal(DeviceKinds.Gate, json.GetProperty("kind").GetString());
            Assert.Equal(45, json.GetProperty("heartbeat_seconds").GetInt32());
            Assert.Equal(TenantSettingsView.DefaultGateUnlockSeconds, json.GetProperty("gate").GetProperty("unlock_seconds").GetInt32());
            Assert.Empty(json.GetProperty("roster").EnumerateArray());

            // Present, and null: a firmware that read an absent key as an empty string and a
            // null one as an error would diverge on exactly the gate nobody has named yet.
            Assert.Equal(JsonValueKind.Null, json.GetProperty("gate_key").ValueKind);

            Assert.False(json.TryGetProperty("court_numbers", out _));
            Assert.False(json.TryGetProperty("config", out _));
            Assert.False(json.TryGetProperty("button_map", out _));

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
            Assert.Equal(DeviceKind.Gate, device.Kind);
            Assert.Equal(DeviceHardware.Esp32, device.Hardware);
            Assert.Empty(device.CourtNumbers);
            Assert.True(device.AutoRegistered);
        }

        /// <summary>
        /// The court box's heartbeat is byte-for-byte the behaviour it was: no <c>kind</c> sent,
        /// and everything it has always been answered. The hint is additive, and this is what
        /// says so — every board in the field today takes this path.
        /// </summary>
        [SkippableTheory]
        [InlineData(null)]
        [InlineData("court_box")]
        public async Task A_board_that_says_nothing_or_says_court_box_is_a_court_box(string? kind)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var mac = NewMac();
            var client = factory.CreateClient();

            var json = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, kind)));

            Assert.Equal($"box-{mac[^6..]}", json.GetProperty("device_code").GetString());
            Assert.Equal(new[] { 1 }, json.GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()));
            Assert.Equal(15, json.GetProperty("config").GetProperty("slice_minutes").GetInt32());

            // A court box is not told a kind, so a firmware that started reading the field would
            // find nothing rather than something wrong.
            Assert.False(json.TryGetProperty("kind", out _));
            Assert.False(json.TryGetProperty("gate", out _));
        }

        /// <summary>
        /// A kind this server does not have is a 400 rather than a silent court box. Refused
        /// before the MAC is resolved, so the answer does not depend on whether the board has a
        /// row yet — a firmware that discovers its own bug only after somebody deletes its row
        /// discovers it at the worst possible moment.
        /// </summary>
        [SkippableTheory]
        [InlineData("turnstile")]
        [InlineData("Gate")]
        [InlineData("courtbox")]
        public async Task A_kind_this_server_does_not_have_is_refused(string kind)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = NewMac();

            var unknown = await client.SendAsync(Heartbeat(club.Key, mac, kind));
            Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
            Assert.Equal(DeviceEndpoints.KindUnknown, (await BodyAsync(unknown)).GetProperty("error").GetString());

            // …and it is still refused once the board HAS a row, which is the half an
            // "ignore the hint on a known MAC" reading would have got wrong.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Heartbeat(club.Key, mac, kind))).StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(1, await db.Devices.IgnoreQueryFilters().CountAsync(d => d.MacAddress == mac));
        }

        /// <summary>
        /// <b>A board cannot re-kind itself.</b> Once the row exists its kind is authoritative
        /// and the hint is ignored outright, in both directions. A gate that could turn its row
        /// into a court box would hand itself the club's courts; a box that could turn itself
        /// into a gate would drop off the settlement model's map of which courts have a working
        /// door, and start waiving no-show penalties on them.
        /// </summary>
        [SkippableFact]
        public async Task A_board_cannot_re_kind_a_row_that_already_exists()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();

            var boxMac = NewMac();
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);
            var stillABox = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, boxMac, DeviceKinds.Gate)));
            Assert.True(stillABox.TryGetProperty("court_numbers", out _));
            Assert.False(stillABox.TryGetProperty("kind", out _));

            var gateMac = await GateAsync(factory, club, client);
            var stillAGate = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, gateMac, DeviceKinds.CourtBox)));
            Assert.Equal(DeviceKinds.Gate, stillAGate.GetProperty("kind").GetString());
            Assert.False(stillAGate.TryGetProperty("court_numbers", out _));

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(DeviceKind.CourtBox, (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == boxMac)).Kind);
            Assert.Equal(DeviceKind.Gate, (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).Kind);
        }

        /// <summary>
        /// The roster a gate is pushed is the CLUB's bookings on any court, and it carries the
        /// booking's own activation code on relay 0.
        /// </summary>
        [SkippableFact]
        public async Task A_gates_roster_carries_the_clubs_bookings_on_relay_zero()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client, "front-door");

            await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));

            var json = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));
            var roster = json.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();

            var entry = Assert.Single(roster);
            Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry);
            Assert.Equal("0", entry.Split('|')[1]);
            Assert.Equal("front-door", json.GetProperty("gate_key").GetString());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.NotNull(await db.AccessCodes.IgnoreQueryFilters()
                .FirstOrDefaultAsync(c => c.TenantId == club.TenantId && c.Code == entry.Split('|')[0]));
        }

        /// <summary>
        /// <b>The barred-member filter, on real Postgres, on BOTH roster builders.</b>
        ///
        /// <para>
        /// Both builders carry the same inline membership subquery —
        /// <c>!db.Memberships.Any(m =&gt; m.UserId == b.UserId &amp;&amp; m.Status != Active)</c> — written out
        /// longhand rather than as the captured <c>MembershipAccess</c> expression, because a
        /// captured expression does not translate inside a subquery. That is a provider-shaped
        /// workaround, and every test that exercised it ran against the EF <b>in-memory</b>
        /// provider, which evaluates the whole predicate in C# and would have been perfectly happy
        /// with the captured form too. So the one thing the longhand exists for — that Npgsql can
        /// translate it — was pinned nowhere.
        /// </para>
        ///
        /// <para>
        /// A filter that throws, or that silently degrades to a client evaluation, is a suspension
        /// that holds only while the gate can reach the API — and the window in which a club most
        /// wants it to hold is the one where nobody is watching. Driven through the real heartbeat
        /// route, with the member Active first, so an empty roster cannot be an empty fixture.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(true)]
        [InlineData(false)]
        public async Task A_barred_members_booking_is_filtered_out_on_real_postgres(bool gate)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();

            var mac = gate
                ? await GateAsync(factory, club, client, "front-door")
                : await CourtBoxAsync(club, client);

            await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));

            // The control: while the membership is Active the code is pushed, so the assertion
            // below is the filter and not an empty club.
            var kind = gate ? DeviceKinds.Gate : null;
            var whileActive = await RosterAsync(client, club, mac, kind);
            Assert.Single(whileActive);

            await SuspendAsync(factory, club);

            Assert.Empty(await RosterAsync(client, club, mac, kind));

            // …and the code itself still exists. The roster dropped it; nothing revoked it, which
            // is what keeps a court box deciding offline from a roster fetched beforehand honest.
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.NotNull(await db.AccessCodes.IgnoreQueryFilters()
                .FirstOrDefaultAsync(c => c.TenantId == club.TenantId && c.Code == whileActive[0].Split('|')[0]));
        }

        /// <summary>
        /// <b>A hand-edited settings column emptied every door's cache in the club, silently.</b>
        ///
        /// <para>
        /// G2's B1 clamped the three numbers the online decision reads and left both roster
        /// builders reading the window raw. <c>TenantSettingsAccessor.TryInt</c> bounds nothing on
        /// the way in, so <c>roster_window_minutes: -600</c> produced a `latestStart` ten hours in
        /// the past and matched no booking at all: a clean 200, a present-and-empty <c>roster</c>
        /// key, no error and no log — and every door in the club admitting nobody the moment its
        /// link dropped. The failure mode the clamp exists for is exactly this one, because a
        /// value the PUT would refuse still reaches the reader.
        /// </para>
        ///
        /// <para>
        /// Both builders, in one test, because they are two copies of the same arithmetic and the
        /// court box's is the one that turns lights on.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_hand_edited_roster_window_cannot_silently_empty_a_boards_cache()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", NegativeRosterWindowSettings);
            var client = factory.CreateClient();
            var gateMac = await GateAsync(factory, club, client, "front-door");
            var boxMac = await CourtBoxAsync(club, client);

            // Ten minutes out, which is inside BOTH clamped windows and outside a ten-hour
            // negative one. The two builders reach differently — a gate adds the entry window
            // (5 + 30) and a box the lights-on cue (5 + 10) — so the booking has to clear the
            // narrower of the two for this to say anything about both.
            await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(10));

            Assert.Single(await RosterAsync(client, club, gateMac, DeviceKinds.Gate));
            Assert.Single(await RosterAsync(client, club, boxMac, null));
        }

        /// <summary>
        /// <b>A board nobody has named gets no roster.</b> Online scans work from its first
        /// heartbeat, so the install stays plug-and-play; the offline fallback starts when an
        /// admin names the door.
        ///
        /// <para>
        /// Auto-registration is the whole provisioning story: anything holding the club's device
        /// key can heartbeat with a MAC it invented and a <c>kind</c> of <c>gate</c>, and a row
        /// appears. Before this, that one call was answered with the club's live access codes for
        /// every booking in the roster window — forty-eight of them, each of which opens every
        /// door in the club for the length of its booking. Naming the door is the admin's
        /// acknowledgement that the board is one of theirs, and it is the cheapest possible gate
        /// on the only call that hands out credentials.
        /// </para>
        ///
        /// <para>
        /// The same board, the same booking and the same request either side of the PATCH is what
        /// makes this discriminate: the roster is empty because the door has no name, not because
        /// there was nothing to send.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task An_unnamed_gate_is_pushed_no_roster_until_an_admin_names_the_door()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);
            await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));

            var unnamed = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));

            // Present and empty, never absent: the firmware replaces its cache wholesale, and an
            // omitted key would leave whatever it already held live.
            Assert.Equal(JsonValueKind.Array, unnamed.GetProperty("roster").ValueKind);
            Assert.Empty(unnamed.GetProperty("roster").EnumerateArray());
            Assert.Equal(JsonValueKind.Null, unnamed.GetProperty("gate_key").ValueKind);

            // …and the door still works online from the first heartbeat, which is what keeps the
            // install plug-and-play. Only the OFFLINE fallback waits for the admin.
            var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);
            Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());

            var (gateId, _) = await IdsAsync(factory, mac, mac);
            var admin = await AdminClientAsync(factory, club);
            Assert.Equal(HttpStatusCode.OK,
                (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "front-door" })).StatusCode);

            var named = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));
            Assert.Equal("front-door", named.GetProperty("gate_key").GetString());
            var entry = Assert.Single(named.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!));
            Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry);
        }

        /// <summary>
        /// <b>Auto-registration is unbounded, and unbounded is a resource anybody with the club
        /// key can spend.</b>
        ///
        /// <para>
        /// Every invented MAC that heartbeats leaves a permanent row: on the Devices page, in the
        /// audit trail as <c>device.auto_registered</c>, and — until the fix beside this one — in
        /// every admin's inbox as soon as it went quiet. The rate limit is the only ceiling, which
        /// is thousands of rows an hour. Nothing deletes them but an admin, one at a time.
        /// </para>
        ///
        /// <para>
        /// So a club may hold at most <see cref="DeviceRegistryService.MaxUnacknowledgedDevices"/>
        /// boards nobody has looked at. It is deliberately a count of the UNACKNOWLEDGED rather
        /// than of all rows: a club with forty real boards is never near it, and the way out is
        /// the thing an admin was going to do anyway — open the page and edit or delete the rows
        /// that appeared. A cap on the total would eventually stop a real installation.
        /// </para>
        ///
        /// <para>
        /// <b>409 and not 403.</b> A 403 on this route group means one thing and one thing only —
        /// this board is out of service — and the firmware acts on that word: it commits an empty
        /// roster and stops falling back. A registration refusal answered 403 would take every
        /// door in the club out of service the moment somebody flooded the registry, which is a
        /// far worse outcome than the flood. `DeviceForbiddenMeansOutOfServiceTests` pins the
        /// converse; this pins the case that would have broken it.
        /// </para>
        /// </summary>
        /// <summary>
        /// D2-B30. The cap holds when the boards arrive TOGETHER, which is the only way a flood
        /// ever arrives.
        ///
        /// <para>
        /// <b>A COUNT followed by an INSERT is not a limit.</b> The check read "fewer than sixteen"
        /// and the insert happened afterwards, with nothing in between to stop a second caller
        /// reading the same answer — so thirty-two heartbeats in flight together with thirty-two
        /// invented MACs and one valid club key all passed, and all thirty-two rows landed. The
        /// only unique index is on <c>(TenantId, MacAddress)</c>, which constrains identity and
        /// says nothing whatever about a count. The real ceiling was the per-minute rate limit — a
        /// different and much larger number — and every row past the cap is permanent.
        /// </para>
        ///
        /// <para>
        /// The sequential test above passes against the defect, which is why it did not find it:
        /// one request at a time can never observe the window. This one fires
        /// <c>2 × MaxUnacknowledgedDevices</c> at once from an empty club and asserts the row
        /// count afterwards.
        /// </para>
        ///
        /// <para><b>Mutant:</b> remove the registration lock. The count comes back above the cap.</para>
        /// </summary>
        [SkippableFact]
        public async Task Boards_arriving_together_cannot_walk_past_the_cap()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gaterace", DefaultSettings);
            var client = factory.CreateClient();

            var attempts = DeviceRegistryService.MaxUnacknowledgedDevices * 2;
            var inFlight = Enumerable.Range(0, attempts)
                .Select(_ => client.SendAsync(Heartbeat(club.Key, NewMac(), DeviceKinds.Gate)))
                .ToList();

            var answers = await Task.WhenAll(inFlight);
            var admitted = answers.Count(r => r.StatusCode == HttpStatusCode.OK);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var rows = await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == club.TenantId);

            Assert.True(
                rows <= DeviceRegistryService.MaxUnacknowledgedDevices,
                $"{attempts} boards arriving together left {rows} rows against a cap of {DeviceRegistryService.MaxUnacknowledgedDevices} — the count-then-insert window is open");

            // …and the answers agree with the rows: a board told OK has one. Every other answer
            // is named in the message: a load-only failure here (16 rows, 15 OK — review round 4)
            // was a request that registered and then failed AFTER the commit, not a cap race; the
            // forced interleaving below proves the cap itself.
            Assert.True(rows == admitted, $"{rows} rows, {admitted} OK; the rest: {await OtherAnswersAsync(answers)}");

            foreach (var answer in answers) answer.Dispose();
        }

        /// <summary>
        /// The same flood, with the worst interleaving FORCED rather than hoped for (review
        /// round 4): the test holds the club's registration lock from its own connection, fires
        /// every board, waits until all of them are parked on that lock, and only then lets go —
        /// so every one of them reaches the count-then-insert at the same moment. Exactly the cap
        /// is admitted, every other board is the 409, and each admitted board has its row.
        /// </summary>
        [SkippableFact]
        public async Task Boards_all_queued_on_the_lock_at_once_still_stop_at_the_cap()
        {
            Skip.IfNot(_pg.Available, Skipped);

            var factory = CreateFactory();
            var club = await ClubAsync(factory, "gatequeue", DefaultSettings);
            var client = factory.CreateClient();
            var attempts = DeviceRegistryService.MaxUnacknowledgedDevices * 2;

            await using var holder = new Npgsql.NpgsqlConnection(_pg.ConnectionString);
            await holder.OpenAsync();
            await using var hold = await holder.BeginTransactionAsync();
            await using (var take = new Npgsql.NpgsqlCommand("SELECT pg_advisory_xact_lock(@k)", holder, hold))
            {
                take.Parameters.AddWithValue("k", PayerLock.KeyFor(club.TenantId, Guid.Empty));
                await take.ExecuteNonQueryAsync();
            }

            var inFlight = Enumerable.Range(0, attempts)
                .Select(_ => client.SendAsync(Heartbeat(club.Key, NewMac(), DeviceKinds.Gate)))
                .ToList();
            for (var i = 0; i < 600; i++)
            {
                await using var waiting = new Npgsql.NpgsqlCommand(
                    "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted", holder);
                if ((long)(await waiting.ExecuteScalarAsync())! >= attempts) break;
                await Task.Delay(100);
            }
            await hold.CommitAsync();

            var answers = await Task.WhenAll(inFlight);
            var admitted = answers.Count(r => r.StatusCode == HttpStatusCode.OK);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var rows = await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == club.TenantId);

            Assert.Equal(DeviceRegistryService.MaxUnacknowledgedDevices, rows);
            Assert.True(rows == admitted, $"{rows} rows, {admitted} OK; the rest: {await OtherAnswersAsync(answers)}");
            Assert.All(answers.Where(r => r.StatusCode != HttpStatusCode.OK),
                r => Assert.Equal(HttpStatusCode.Conflict, r.StatusCode));

            foreach (var answer in answers) answer.Dispose();
        }

        /// <summary>Every answer that was neither OK nor the cap's 409, with its body — for a failure message.</summary>
        private static async Task<string> OtherAnswersAsync(IEnumerable<HttpResponseMessage> answers)
        {
            var odd = new List<string>();
            foreach (var r in answers.Where(r => r.StatusCode is not HttpStatusCode.OK and not HttpStatusCode.Conflict))
            {
                odd.Add($"{(int)r.StatusCode} {await r.Content.ReadAsStringAsync()}");
            }
            return odd.Count == 0 ? "only 409s" : string.Join(" | ", odd);
        }

        [SkippableFact]
        public async Task A_club_cannot_be_filled_with_boards_nobody_has_acknowledged()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();

            var macs = new List<string>();
            for (var i = 0; i < DeviceRegistryService.MaxUnacknowledgedDevices; i++)
            {
                var mac = NewMac();
                macs.Add(mac);
                Assert.Equal(HttpStatusCode.OK,
                    (await client.SendAsync(Heartbeat(club.Key, mac, i % 2 == 0 ? DeviceKinds.Gate : null))).StatusCode);
            }

            // The one after the cap is refused — and the refusal is 409, never 403.
            var flooded = await client.SendAsync(Heartbeat(club.Key, NewMac(), DeviceKinds.Gate));
            Assert.Equal(HttpStatusCode.Conflict, flooded.StatusCode);
            Assert.Equal(
                DeviceRegistryService.TooManyUnacknowledgedDevices,
                (await BodyAsync(flooded)).GetProperty("error").GetString());

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                Assert.Equal(
                    DeviceRegistryService.MaxUnacknowledgedDevices,
                    await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == club.TenantId));
            }

            // The boards that DID register are unaffected: the cap is on creating a row, never on
            // serving one. A club at its limit must not have its installed doors stop working.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, macs[0], DeviceKinds.Gate))).StatusCode);

            // The probe: ONE admin edit, which is what clears AutoRegistered, and the next board
            // registers. The way out is the thing the admin was going to do anyway.
            var admin = await AdminClientAsync(factory, club);
            Guid firstId;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                firstId = (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == macs[0])).Id;
            }
            Assert.Equal(HttpStatusCode.OK,
                (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{firstId}", new { gate_key = "front-door" })).StatusCode);

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, NewMac(), DeviceKinds.Gate))).StatusCode);
        }
    }
}
