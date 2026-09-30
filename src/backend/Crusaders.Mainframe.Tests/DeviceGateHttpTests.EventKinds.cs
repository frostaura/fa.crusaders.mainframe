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
    /// <summary>An uploaded event's kind is normalised, a malformed one is receipted, and diagnostic counters change nothing.</summary>
    public sealed class EventKinds(PostgresFixture pg) : DeviceGateHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// <b>The fingerprint guard was keyed on the RAW <c>kind</c>, and every other decision on
        /// this route was keyed on the trimmed one.</b> A single space is the whole exploit.
        ///
        /// <para>
        /// <c>AuditKind</c> trims, so <c>" gate_open "</c> is stored, receipted and audited as
        /// <c>device.gate_open</c> — indistinguishable in the trail from an honest one. The
        /// subject guard did not: <c>e.Kind is not (GateOpenKind or UnknownScanKind)</c> is false
        /// for the padded spelling, so the branch fell through and wrote <b>the live access code
        /// in full</b> into <c>DetailsJson</c>. That is the exact credential-in-a-log the G2 fix
        /// removed, available to anything holding the club key by adding one character.
        /// </para>
        ///
        /// <para>
        /// The dispatch switch was keyed on the raw value too, which makes the same spelling a
        /// SECOND bypass: <c>GateOpenKind when device.Kind != Gate</c> never matched
        /// <c>" gate_open "</c>, so a COURT BOX could post a door open, skip the
        /// <c>not_a_gate</c> refusal that exists to stop a false record of who was in the
        /// building, and land in the <c>_ => null</c> arm with the token beside it.
        /// </para>
        ///
        /// <para>
        /// Upper case is the same hole by a different route — a scanner or a firmware branch that
        /// shouts — and it has a second cost the padding does not: it fragments the trail, because
        /// <c>device.GATE_OPEN</c> is a row the console's activity query does not find.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(" gate_open ")]
        [InlineData("GATE_OPEN")]
        [InlineData("Gate_Open")]
        [InlineData("\tunknown_scan\n")]
        [InlineData("UNKNOWN_SCAN")]
        public async Task A_door_event_kind_is_normalised_before_anything_is_decided_from_it(string spelling)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
            var token = await BookingCodeAsync(factory, club, booking);
            var canonical = spelling.Trim().ToLowerInvariant();

            var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(DoorEvent(21, spelling, token)),
            }));
            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            // The receipt and the audit row carry the canonical spelling, so the trail is one
            // stream rather than one per way of writing the word.
            var receipt = Assert.Single(await db.DeviceEventReceipts.IgnoreQueryFilters()
                .Where(r => r.TenantId == club.TenantId).ToListAsync());
            Assert.Equal(canonical, receipt.Kind);

            var row = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{canonical}").ToListAsync());

            // And the token is nowhere in it.
            Assert.DoesNotContain(token, row.DetailsJson, StringComparison.OrdinalIgnoreCase);
            var subject = JsonDocument.Parse(row.DetailsJson!).RootElement.GetProperty("subject").GetString()!;
            Assert.Equal(8, subject.Length);
        }

        /// <summary>
        /// A kind this server has never heard of is recorded as it was normalised — it is
        /// evidence, and the board cannot edit what it has queued — but its subject is
        /// fingerprinted like every other, because "we do not recognise this word" is not a reason
        /// to write a live credential into the trail.
        /// </summary>
        [SkippableFact]
        public async Task An_unknown_kind_is_recorded_as_normalised_and_still_fingerprinted()
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
            var token = await BookingCodeAsync(factory, club, booking);

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(DoorEvent(51, "  Turnstile_Spun  ", token)),
            }))).StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            var receipt = Assert.Single(await db.DeviceEventReceipts.IgnoreQueryFilters()
                .Where(r => r.TenantId == club.TenantId).ToListAsync());
            Assert.Equal("turnstile_spun", receipt.Kind);

            var row = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action == "device.turnstile_spun").ToListAsync());
            Assert.DoesNotContain(token, row.DetailsJson, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(
                8, JsonDocument.Parse(row.DetailsJson!).RootElement.GetProperty("subject").GetString()!.Length);
        }

        /// <summary>
        /// <b>One malformed event must not pin the board's queue for ever.</b>
        ///
        /// <para>
        /// A JSON null in <c>kind</c> went straight into <c>e.Kind.Length</c> and answered 500; a
        /// kind of 200 characters overflowed <c>AuditLog.Action</c> (128) and answered 500 from
        /// the save. Either one is permanent: the firmware drains only up to
        /// <c>accepted_through</c> and re-posts the rest, so a malformed event at the head of a
        /// ring stops every event behind it from ever arriving — including the activations the
        /// no-show sweep is waiting on, which is real money. A board cannot edit what it has
        /// already queued, so the only exit is a receipt.
        /// </para>
        ///
        /// <para>
        /// The second event in each batch is a good one, and the assertion that it was recorded is
        /// what says the batch got PAST the bad one rather than merely surviving it.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("gate_open_but_very_much_longer_than_the_column_will_take_and_then_some_more_again")]
        public async Task A_malformed_event_kind_is_receipted_rather_than_five_hundred(string? kind)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = await GateAsync(factory, club, client);

            var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
            var token = await BookingCodeAsync(factory, club, booking);

            var bad = DoorEvent(21, DeviceEventEndpoints.GateOpenKind, token);
            bad["kind"] = kind is null ? null : JsonValue.Create(kind);

            var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
            {
                ["mac"] = mac,
                ["uptime_ms"] = 3_600_000,
                ["events"] = new JsonArray(bad, DoorEvent(22, DeviceEventEndpoints.GateOpenKind, token)),
            }));

            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

            // Acknowledged THROUGH the good event behind it: this is the assertion that says the
            // queue drains rather than stalls.
            var body = await BodyAsync(upload);
            Assert.Equal(22, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(2, body.GetProperty("recorded").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            var receipt = await db.DeviceEventReceipts.IgnoreQueryFilters()
                .SingleAsync(r => r.TenantId == club.TenantId && r.Seq == 21);
            Assert.True(receipt.Kind.Length <= DeviceEventEndpoints.MaxKindLength);
            Assert.False(string.IsNullOrEmpty(receipt.Kind));

            // Its own audit row, so the desk can see a board is sending rubbish rather than
            // inferring it from a gap in the sequence numbers.
            var malformed = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == club.TenantId && a.Action.EndsWith($"_{DeviceEventEndpoints.Malformed}"))
                .ToListAsync();
            Assert.Single(malformed);
            Assert.All(malformed, a => Assert.True(a.Action.Length <= 128));
        }

        /// <summary>
        /// <b>A diagnostic counter must not be able to take a door out of service, and one could.</b>
        ///
        /// <para>
        /// Both counters are SINCE-BOOT TOTALS — the board cannot know which report the server
        /// kept, so a counter reset on send loses the whole count on any lost response — and both
        /// SATURATE at <c>INT32_MAX</c> rather than wrapping. <c>no_push</c> bound as
        /// <c>int?</c>, so the very first value past that saturation point was a <b>400 for the
        /// whole heartbeat</b>: no <c>gate</c> block, no <c>roster</c>, nothing. A door that had
        /// been up long enough to saturate a counter then lost its cache at the next stale
        /// deadline, and the field's own contract vector says in as many words that this must
        /// never happen. Binding is now 64-bit and an out-of-range value is IGNORED.
        /// </para>
        ///
        /// <para>
        /// The values below are the real shape of the problem: the saturation point, one past it,
        /// <c>long.MaxValue</c> for a board or proxy that does something else entirely, and
        /// negatives, which are not counters.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(4L, null)]
        [InlineData(0L, 0L)]
        [InlineData(-1L, -7L)]
        [InlineData(2147483647L, 2147483647L)]
        [InlineData(2147483648L, 2147483648L)]
        [InlineData(long.MaxValue, long.MinValue)]
        [InlineData(null, 12L)]
        public async Task The_boards_diagnostic_counters_are_accepted_and_change_nothing(long? noPush, long? eventsLost)
        {
            Skip.IfNot(_pg.Available, Skipped);

            await using var factory = CreateFactory();
            var club = await ClubAsync(factory, "gate", DefaultSettings);
            var client = factory.CreateClient();
            var mac = NewMac();

            var body = new JsonObject
            {
                ["mac"] = mac,
                ["firmware_version"] = "1.0.0",
                ["uptime_ms"] = 60000,
                ["kind"] = DeviceKinds.Gate,
            };
            if (noPush is { } n) body["no_push"] = n;
            if (eventsLost is { } e) body["events_lost"] = e;

            var response = await client.SendAsync(Signed(club.Key, HeartbeatPath, body));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var json = await BodyAsync(response);

            // The whole answer is intact, which is the point: a door that cannot read its roster
            // is a door that admits nobody at the next stale deadline.
            Assert.Equal(DeviceKinds.Gate, json.GetProperty("kind").GetString());
            Assert.Equal(TenantSettingsView.DefaultGateUnlockSeconds, json.GetProperty("gate").GetProperty("unlock_seconds").GetInt32());
            Assert.Equal(JsonValueKind.Array, json.GetProperty("roster").ValueKind);

            // And neither counter comes back or is stored: they are logged and nothing else.
            Assert.False(json.TryGetProperty("no_push", out _));
            Assert.False(json.TryGetProperty("events_lost", out _));
        }
    }
}
