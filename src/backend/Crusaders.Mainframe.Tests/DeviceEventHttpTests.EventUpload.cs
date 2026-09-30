using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

public abstract partial class DeviceEventHttpTests
{
    /// <summary>The box's event upload: batching, sequence dedup, replays, bounds and signatures.</summary>
    public sealed class EventUpload(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- uploading what happened ------------------------------------------

        [SkippableFact]
        public async Task A_batch_is_recorded_and_acknowledged_by_sequence_number()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            var response = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2), Activation(3))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            // A sequence number, not a bare 200: the box releases its queue up to this and no
            // further, so a partial success loses nothing.
            Assert.Equal(3, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(3, body.GetProperty("recorded").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(3, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
        }

        /// <summary>
        /// An upload is a liveness signal too, and it is very often the FIRST call a box makes
        /// when it reconnects — it has a queue to drain. So it has to leave the same evidence a
        /// heartbeat does: the silence it just ended, recorded as a closed <c>DeviceOutage</c>.
        /// Without it the no-show waiver settles the outage window differently depending on
        /// whether the health sweep happened to catch the box while it was still dark. The
        /// heartbeat half of this is
        /// <c>DeviceAuthHttpTests.A_heartbeat_that_ends_a_long_silence_records_the_outage_it_ended</c>.
        /// </summary>
        [SkippableFact]
        public async Task An_upload_that_ends_a_long_silence_records_the_outage_it_ended()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            // Twenty minutes dark, which is far past the 180-second floor under
            // offline_after_seconds, and then the box drains its queue.
            var wentQuietAt = DateTimeOffset.UtcNow.AddMinutes(-20);
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == box.DeviceId);
                device.LastSeenAt = wentQuietAt;
                await db.SaveChangesAsync();
            }

            var response = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var outage = Assert.Single(await db.DeviceOutages.IgnoreQueryFilters()
                    .Where(o => o.DeviceId == box.DeviceId).ToListAsync());
                Assert.Equal(wentQuietAt, outage.StartedAt, TimeSpan.FromSeconds(1));
                Assert.NotNull(outage.EndedAt);

                // A4: an upload IS contact, so "last heard from" is the UPLOAD — not the scan the
                // upload carried, which may be hours older. The doors page says both and neither
                // is inferred from the other: `last_seen_at` is when the board called in, the
                // row's `at` is when somebody stood at the door, and its `delivered_at` is this
                // same instant. A page that read the scan as contact would report a board healthy
                // while it was still dark.
                var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == box.DeviceId);
                Assert.Equal(DateTimeOffset.UtcNow, device.LastSeenAt!.Value, TimeSpan.FromMinutes(1));
            }
        }

        [SkippableFact]
        public async Task A_replayed_batch_is_acknowledged_without_being_recorded_twice()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));

            // The box uploaded, lost the link before reading the response, and tried again.
            // That is normal traffic on an unreliable network, not an error — so it must be
            // acknowledged, and it must not double-record.
            var again = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);

            var body = await again.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(2, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(0, body.GetProperty("recorded").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(2, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
        }

        /// <summary>
        /// G4 / C2, AND IT IS THE REASON <c>boot_id</c> EXISTS.
        ///
        /// <para>
        /// A board's ring is RAM-only and its <c>seq</c> resumes from one checkpoint record in
        /// flash. Erase or tear that record — a reflash, a wiped NVS partition, a torn write —
        /// and the board renumbers from 1 against a PERMANENT unique index: under
        /// <c>(device, seq)</c> the whole of the next evening came back as duplicates and was
        /// discarded, <i>including</i> the <c>boot</c> event that exists to tell an operator the
        /// board restarted. The board sees a clean 200 with <c>accepted_through</c> covering
        /// everything it sent and releases its ring, so the evidence is gone from both ends.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_board_that_renumbered_after_a_torn_sequence_mark_is_not_deduped_away()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            // An evening's work, from the boot that is about to end.
            await client.SendAsync(FromBox(box, EventsPath,
                BatchFromBoot(0x9AD1_F0F0, Activation(1), Activation(2), Activation(3))));

            // The board reboots, its checkpoint is gone, and it starts again at 1.
            var afterReboot = await client.SendAsync(FromBox(box, EventsPath,
                BatchFromBoot(0x2BCD_1234, Activation(1, subject: "tok-alice"), Activation(2, subject: "tok-alice"))));

            Assert.Equal(HttpStatusCode.OK, afterReboot.StatusCode);
            var body = await afterReboot.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(2, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(2, body.GetProperty("recorded").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(5, await db.DeviceEventReceipts.IgnoreQueryFilters()
                .CountAsync(r => r.DeviceId == box.DeviceId));

            // AND A RETRY WITHIN A BOOT IS STILL A RETRY. The whole point of the key is that it
            // keeps deduplicating what it always deduplicated.
            var retry = await client.SendAsync(FromBox(box, EventsPath,
                BatchFromBoot(0x2BCD_1234, Activation(1), Activation(2))));
            Assert.Equal(0, (await retry.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("recorded").GetInt32());
            Assert.Equal(5, await db.DeviceEventReceipts.IgnoreQueryFilters()
                .CountAsync(r => r.DeviceId == box.DeviceId));
        }

        /// <summary>
        /// C2's compatibility half. A body with NO <c>boot_id</c> is boot 0, which is exactly
        /// what <c>(device, seq)</c> always meant — so a court box, whose renderer omits the
        /// field, and every gate image flashed before this change keep deduplicating against
        /// themselves, and legacy rows (backfilled to 0) keep matching the boards that wrote them.
        /// </summary>
        [SkippableFact]
        public async Task A_batch_with_no_boot_id_deduplicates_exactly_as_it_always_did()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));
            var again = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));
            Assert.Equal(0, (await again.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("recorded").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var receipts = await db.DeviceEventReceipts.IgnoreQueryFilters()
                .Where(r => r.DeviceId == box.DeviceId).ToListAsync();
            Assert.Equal(2, receipts.Count);
            Assert.All(receipts, r => Assert.Equal(0, r.BootId));

            // An explicit 0 is the same boot as an absent one, which is what makes the backfill
            // a compatibility statement rather than a placeholder.
            var explicitZero = await client.SendAsync(FromBox(box, EventsPath,
                BatchFromBoot(0, Activation(1), Activation(2))));
            Assert.Equal(0, (await explicitZero.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("recorded").GetInt32());

            // And a NAMED boot is a different board-life: the same sequence numbers record again.
            var named = await client.SendAsync(FromBox(box, EventsPath,
                BatchFromBoot(0x7777_0001, Activation(1), Activation(2))));
            Assert.Equal(2, (await named.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("recorded").GetInt32());
        }

        /// <summary>
        /// C2's other half, which M1 reported separately: two boards that end up on one MAC —
        /// a cloned image, a spare flashed from a backup, a MAC typed into a config twice —
        /// resolve to ONE device row and were deduping each other's evidence away. Different
        /// boots are different board-lives whether they are two boots of one board or two boards.
        /// </summary>
        [SkippableFact]
        public async Task Two_boards_sharing_one_mac_no_longer_suppress_each_others_records()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            var first = await client.SendAsync(FromBox(box, EventsPath,
                BatchFromBoot(0x1111_1111, Activation(1), Activation(2))));
            var second = await client.SendAsync(FromBox(box, EventsPath,
                BatchFromBoot(0x2222_2222, Activation(1), Activation(2))));

            Assert.Equal(2, (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("recorded").GetInt32());
            Assert.Equal(2, (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("recorded").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(4, await db.DeviceEventReceipts.IgnoreQueryFilters()
                .CountAsync(r => r.DeviceId == box.DeviceId));
        }

        [SkippableFact]
        public async Task A_batch_that_overlaps_an_earlier_one_records_only_what_is_new()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));

            // The realistic retry: the box never saw the acknowledgement, so it re-offers what it
            // still holds — which by then includes newer events too.
            var overlapping = await client.SendAsync(
                FromBox(box, EventsPath, Batch(Activation(2), Activation(3), Activation(4))));

            var body = await overlapping.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(4, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(2, body.GetProperty("recorded").GetInt32());
        }

        [SkippableFact]
        public async Task An_oversized_batch_is_bounded_rather_than_refused()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            var many = Enumerable.Range(1, 100).Select(i => Activation(i)).ToArray();
            var response = await client.SendAsync(FromBox(box, EventsPath, Batch(many)));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            // A board back from a week offline arrives with a full ring. Refusing it outright
            // would strand the whole queue; one request that takes a minute times out and gets
            // retried forever. It takes what it can and the box offers the rest.
            Assert.Equal(Crusaders.Mainframe.Api.Endpoints.DeviceEventEndpoints.MaxBatch,
                body.GetProperty("accepted_through").GetInt64());
        }

        [SkippableFact]
        public async Task An_unsigned_upload_is_refused()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            await SeedAsync(factory);
            var client = factory.CreateClient();

            var response = await client.PostAsJsonAsync(EventsPath, Batch(Activation(1)));
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }

        /// <summary>
        /// The box lost the acknowledgement and sent the same batch again. One stamp, one
        /// <c>court.activated</c> row, and the second answer accepts the same sequence number
        /// having recorded nothing new.
        /// </summary>
        [SkippableFact]
        public async Task Replayed_activation_batch_is_idempotent()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);
            var client = factory.CreateClient();

            var first = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(7, subject: booked.Code, court: 0))));
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            var stampedAt = (await BookingAsync(factory, booked.BookingId)).CheckedInAt;
            Assert.NotNull(stampedAt);

            var again = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(7, subject: booked.Code, court: 0))));
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);
            var body = await again.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(7, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(0, body.GetProperty("recorded").GetInt32());

            Assert.Equal(stampedAt, (await BookingAsync(factory, booked.BookingId)).CheckedInAt);
            Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation"));

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(1, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
        }

        /// <summary>
        /// Eight uploads of one batch in flight together — the retry storm a flapping link
        /// produces. Postgres refuses seven receipts on the unique index and seven stamps on the
        /// concurrency token; every request is answered 200 with the sequence accepted, and
        /// there is one receipt, one stamp and one <c>court.activated</c> row at the end.
        /// </summary>
        [SkippableFact]
        public async Task Concurrent_duplicate_activation_uploads()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);
            var client = factory.CreateClient();

            var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
                client.SendAsync(FromBox(box, EventsPath, Batch(Activation(3, subject: booked.Code, court: 0))))));

            Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
            foreach (var r in responses)
            {
                Assert.Equal(3, (await r.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());
            }

            Assert.NotNull((await BookingAsync(factory, booked.BookingId)).CheckedInAt);
            Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation"));

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(1, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
            Assert.Single(await LedgerAsync(factory, booked.BookingId));   // the seed charge, and nothing else
        }

        /// <summary>
        /// A token the server does not know — expired, never minted, or another club's — is
        /// still acknowledged, so the box can release its queue, and the refusal is preserved
        /// as an audit row: the evidence the box is about to discard.
        ///
        /// <para>
        /// <b>The row carries the token's FINGERPRINT and not the token</b>, which is a change
        /// this test used to assert the opposite of. It asserted the raw bytes were in
        /// <c>DetailsJson</c> — reasonable while an activation token was only a court's roster
        /// token for a booking the receipt already named, and wrong since the door shipped: that
        /// same token now opens every door in the club for the length of its booking's window,
        /// and a trail an admin can read is not where a live credential belongs. What the field
        /// was worth is kept — the fingerprint still correlates two scans of one code — and a
        /// token nobody can resolve is exactly the one somebody will want to correlate.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task Activation_event_with_unknown_token_is_acked_and_audited()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: "ZZZZZZZZZZZZ", court: 0))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(1, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(1, body.GetProperty("recorded").GetInt32());

            Assert.Null((await BookingAsync(factory, booked.BookingId)).CheckedInAt);
            var audit = Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_unresolved"));
            Assert.DoesNotContain("ZZZZZZZZZZZZ", audit.DetailsJson);

            // The eight-hex fingerprint of the normalised token, which is what makes "the same
            // unknown badge, eleven times" a question the trail still answers.
            Assert.Equal(
                "bb134d48",
                System.Text.Json.JsonDocument.Parse(audit.DetailsJson!).RootElement.GetProperty("subject").GetString());

            Assert.Empty(await AuditAsync(factory, box.TenantId, "court.activated"));
        }
    }
}
