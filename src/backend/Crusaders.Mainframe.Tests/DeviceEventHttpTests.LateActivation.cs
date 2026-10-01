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
    /// <summary>Activation events: check-in stamping, the cue window, late uploads that reverse a no-show, and the tail they displace.</summary>
    public sealed class LateActivation(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- activation events become attendance (review C6) -----------------------

        /// <summary>
        /// The C6 headline. The box admitted a member from its roster, queued the activation,
        /// and uploaded it; the no-show sweep then runs past the grace window. Before this the
        /// upload wrote a receipt and nothing else, so the member was swept, refunded and
        /// penalised for a court they played on. Now the event is attendance: no refund, no
        /// penalty, no NoShow.
        /// </summary>
        [SkippableFact]
        public async Task Activation_event_stamps_checked_in_and_survives_no_show_sweep()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            // Started ten minutes ago against a five-minute grace: due for the sweep unless
            // somebody checked in.
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -10);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 1))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(1, body.GetProperty("accepted_through").GetInt64());

            var stamped = await BookingAsync(factory, booked.BookingId);
            Assert.NotNull(stamped.CheckedInAt);

            await SweepAsync(factory);

            var after = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.Booked, after.Status);
            Assert.NotNull(after.CheckedInAt);

            var ledger = await LedgerAsync(factory, booked.BookingId);
            Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.CancellationRefund);
            Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.NoShowPenalty);
            Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
        }

        /// <summary>
        /// The C6 hazard in its remaining form. A box offline for longer than the grace window
        /// lit the court from its roster and queued the scan; by the time WiFi returned the
        /// sweep had settled the booking as a no-show. The uploaded scan used to resolve to
        /// "not chargeable" — the member who played kept the refund, paid the penalty, and the
        /// ledger said they never came. Late evidence now reverses the settlement: two new
        /// rows, the row <c>Booked</c> and checked in at the scan, the balance back where the
        /// charge left it. <c>EndsAt</c> is restored to the end the member paid for — the
        /// lights ran that long from the box's own timer, and a truncated end left the tail
        /// sellable at the box while the court was lit (decision 2026-09-04, review #16).
        /// </summary>
        [SkippableFact]
        public async Task Late_activation_after_the_sweep_reverses_the_no_show()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, swept) = await SweptNoShowAsync(factory, box);

            var mail = new StubEmailService();
            await using var quiet = Quiet(factory, mail);

            // The scan happened five minutes ago, inside the slot, and is only reaching the
            // server now.
            var before = DateTimeOffset.UtcNow;
            var response = await quiet.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));
            var after = DateTimeOffset.UtcNow;
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

            var reversed = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.Booked, reversed.Status);
            Assert.NotNull(reversed.CheckedInAt);
            Assert.InRange(reversed.CheckedInAt!.Value, before.AddMinutes(-5), after.AddMinutes(-5));
            Assert.True(reversed.EndsAt > swept.EndsAt, "the truncated end is restored");
            Assert.Equal(BookingService.OriginalEndsAt(reversed), reversed.EndsAt);
            Assert.Null(reversed.LightsOffCuedAt);   // the real lights-off is still ahead; the cue worker fires it once

            await AssertReversedLedgerAsync(factory, booked.BookingId);
            Assert.Equal(200 - 24, await BalanceAsync(factory, box.MemberId));

            Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_reversed_no_show"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_not_chargeable"));
            Assert.Contains(mail.Sent, m => m.Subject.StartsWith("No-show reversed", StringComparison.Ordinal));
        }

        /// <summary>
        /// The box lost the acknowledgement, or a second scan of the same session arrives
        /// later. The row is live and checked in, so the ordinary idempotent path answers —
        /// no second reversal, no fifth and sixth settlement rows.
        /// </summary>
        [SkippableFact]
        public async Task A_second_late_activation_does_not_reverse_twice()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);

            await using var quiet = Quiet(factory, new StubEmailService());
            var client = quiet.CreateClient();

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);
            var stampedAt = (await BookingAsync(factory, booked.BookingId)).CheckedInAt;
            Assert.NotNull(stampedAt);

            var again = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(2, subject: booked.Code, court: 0))));
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);
            var body = await again.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(2, body.GetProperty("accepted_through").GetInt64());
            Assert.Equal(1, body.GetProperty("recorded").GetInt32());

            var booking = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.Booked, booking.Status);
            Assert.Equal(stampedAt, booking.CheckedInAt);

            await AssertReversedLedgerAsync(factory, booked.BookingId);
            Assert.Equal(200 - 24, await BalanceAsync(factory, box.MemberId));
            Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_reversed_no_show"));
            Assert.Equal(2, (await AuditAsync(factory, box.TenantId, "device.activation")).Count);
        }

        /// <summary>
        /// The mirror of the too-early case. The member scanned five minutes into their slot;
        /// the box only reconnected after the slot had ended and the roster code had expired.
        /// The scan is judged when it happened — the code was live, the cue window was open —
        /// and attendance is stamped at the scan, not at the upload.
        /// </summary>
        [SkippableFact]
        public async Task Activation_event_scanned_inside_the_cue_window_but_uploaded_late_is_stamped_at_scan_time()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            // Started an hour ago and ran forty-five minutes: over, and its code expired with it.
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -60);

            const long batchUptime = 4_000_000;
            const long scannedMinutesAgo = 55;
            var before = DateTimeOffset.UtcNow;
            var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
                BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - scannedMinutesAgo * 60_000))));
            var after = DateTimeOffset.UtcNow;
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var booking = await BookingAsync(factory, booked.BookingId);
            Assert.NotNull(booking.CheckedInAt);
            Assert.InRange(booking.CheckedInAt!.Value, before.AddMinutes(-scannedMinutesAgo), after.AddMinutes(-scannedMinutesAgo));
            Assert.Equal(booking.CheckedInAt, booking.LightsOnCuedAt);
            Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_unresolved"));
        }

        /// <summary>
        /// The other direction of the same rule. The box admitted the member half an hour
        /// before the cue window opened and uploaded the event once it had; judged at the
        /// upload the scan would pass, judged when it happened it is what it was — too early.
        /// </summary>
        [SkippableFact]
        public async Task Activation_event_scanned_ahead_of_the_cue_window_but_uploaded_inside_it_is_not_stamped()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            // Starts in five minutes: the ten-minute cue opened five minutes ago.
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 5);

            const long batchUptime = 4_000_000;
            var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
                BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - 30 * 60_000))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var booking = await BookingAsync(factory, booked.BookingId);
            Assert.Null(booking.CheckedInAt);
            Assert.Null(booking.LightsOnCuedAt);
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "court.activated"));
        }

        /// <summary>
        /// A box's clock is the server's clock minus how long ago its uptime says the event
        /// was. Two claims are not believed: a scan in the FUTURE (the queue outlived a reboot
        /// and carries a previous boot's uptime), and one past the thirty-day sanity bound.
        /// Both are judged at the upload instead and the claim is kept on an audit row so the
        /// desk can see the counter is broken. Anything in between — hours, a day — is the
        /// outage the queue exists for and is believed; see the twenty-hour test below.
        /// </summary>
        [SkippableTheory]
        [InlineData(600_000L, 900_000L)]                 // ahead of the upload: the queue outlived a reboot
        [InlineData(3_000_000_000L, 0L)]                 // thirty-five days behind it: past the sanity bound
        public async Task Activation_event_with_a_wild_occurred_at_is_clamped_and_audited(long batchUptime, long eventUptime)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);

            var before = DateTimeOffset.UtcNow;
            var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
                BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: eventUptime))));
            var after = DateTimeOffset.UtcNow;
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var booking = await BookingAsync(factory, booked.BookingId);
            Assert.NotNull(booking.CheckedInAt);
            Assert.InRange(booking.CheckedInAt!.Value, before, after);

            var clamped = Assert.Single(await AuditAsync(factory, box.TenantId, "device.event_time_clamped"));
            Assert.Contains("occurred_at_clamped_from", clamped.DetailsJson);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var receipt = await db.DeviceEventReceipts.IgnoreQueryFilters().SingleAsync(r => r.DeviceId == box.DeviceId);
            Assert.InRange(receipt.OccurredAt, before, after);
        }

        /// <summary>
        /// The long outage — the case the six-hour clamp destroyed (closing re-review #6/#7).
        /// Router dies at 17:30, the box admits the evening from its roster, the router is
        /// fixed the next afternoon. The member's slot ended nineteen hours before the upload
        /// and was swept as a no-show; the roster code expired at slot end plus grace. Judged
        /// at the upload the code is dead and the event resolves to nothing — refunded,
        /// penalised, a no-show for a court they played on. Judged at the scan, which is
        /// what the arithmetic says and what the box's server-derived clock makes exact, the
        /// code is live and the no-show is reversed.
        /// </summary>
        [SkippableFact]
        public async Task Activation_uploaded_twenty_hours_late_for_a_booking_swept_nineteen_hours_ago_is_reversed()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            // Started 20h05m ago, ran 45 minutes: over since 19h20m ago, code dead since 19h15m ago.
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -(20 * 60 + 5));
            await SweepAsync(factory);
            var swept = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.NoShow, swept.Status);

            var mail = new StubEmailService();
            await using var quiet = Quiet(factory, mail);

            // The box has been up 22 hours; the scan was 20 hours ago, five minutes into the slot.
            const long batchUptime = 22L * 3600 * 1000;
            const long scannedAgoMs = 20L * 3600 * 1000;
            var before = DateTimeOffset.UtcNow;
            var response = await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
                BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - scannedAgoMs))));
            var after = DateTimeOffset.UtcNow;
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var reversed = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.Booked, reversed.Status);
            Assert.NotNull(reversed.CheckedInAt);
            Assert.InRange(reversed.CheckedInAt!.Value, before.AddMilliseconds(-scannedAgoMs), after.AddMilliseconds(-scannedAgoMs));

            await AssertReversedLedgerAsync(factory, booked.BookingId);
            Assert.Equal(200 - 24, await BalanceAsync(factory, box.MemberId));
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_reversed_no_show"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_unresolved"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "device.event_time_clamped"));
            Assert.Contains(mail.Sent, m => m.Subject.StartsWith("No-show reversed", StringComparison.Ordinal));
        }

        /// <summary>
        /// The cue gate applies on the reversal branch too: a box that admitted a member half
        /// an hour before the window opened and then lost the link for a day is reporting a
        /// scan that broke the rule, not one that kept it.
        /// </summary>
        [SkippableFact]
        public async Task A_late_activation_scanned_ahead_of_the_cue_window_does_not_reverse_the_sweep()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -60);
            await SweepAsync(factory);

            // Scanned 100 minutes ago: forty minutes before a slot that started sixty ago.
            const long batchUptime = 4_000_000;
            var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
                BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - 100 * 60_000))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var booking = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.NoShow, booking.Status);
            Assert.Null(booking.CheckedInAt);
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
        }

        /// <summary>
        /// The sweep released A's tail and B bought part of it; A's late event then reverses
        /// A's no-show. B arrived to a lit court with A on it. B is displaced: cancelled with
        /// the whole charge back as its own row (reason ResoldTailRefunded), no penalty, an
        /// audit row, an email, a booking.displaced event — and A's end is restored, so the
        /// tail is not sold a second time at the box while A is still lit. A row the sweep had
        /// already settled (C) gets its penalty back instead of a second refund.
        /// </summary>
        [SkippableFact]
        public async Task A_late_activation_displaces_bookings_sold_on_the_released_tail()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, swept) = await SweptNoShowAsync(factory, box);   // A: started -10, 45 min, tail [now, +35) released
            var buyer = await AnotherMemberAsync(factory, box);
            var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);                       // Booked, charged 8
            var c = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 1, minutes: 15, status: BookingStatus.NoShow); // swept: refunded 8, penalised 2.40
            var buyerBefore = await BalanceAsync(factory, buyer);

            var mail = new StubEmailService();
            await using var quiet = Quiet(factory, mail);
            var response = await quiet.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var a = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.Booked, a.Status);
            Assert.Equal(BookingService.OriginalEndsAt(a), a.EndsAt);
            Assert.True(a.EndsAt > swept.EndsAt);

            var displacedB = await BookingAsync(factory, b.BookingId);
            Assert.Equal(BookingStatus.Cancelled, displacedB.Status);
            Assert.True(displacedB.CancellationPenaltyWaived);
            Assert.Equal(BookingService.ResoldTailRefunded, displacedB.CancellationReason);
            var refundB = Assert.Single(await LedgerAsync(factory, b.BookingId), l => l.Type == LedgerEntryType.CancellationRefund);
            Assert.Equal(8, refundB.AmountMinutes);
            Assert.Contains(BookingService.ResoldTailRefunded, refundB.Reason);
            Assert.Equal(BookingService.DisplacedReference(a.Id, b.BookingId), refundB.ExternalReference);

            var displacedC = await BookingAsync(factory, c.BookingId);
            Assert.Equal(BookingStatus.Cancelled, displacedC.Status);
            var penaltiesC = (await LedgerAsync(factory, c.BookingId)).Where(l => l.Type == LedgerEntryType.NoShowPenalty).ToList();
            Assert.Equal(2, penaltiesC.Count);
            Assert.Equal(0, penaltiesC.Sum(l => l.AmountMinutes));
            Assert.Single(await LedgerAsync(factory, c.BookingId), l => l.Type == LedgerEntryType.CancellationRefund);   // the sweep's; not a second one

            // B's charge back, C's penalty back: the buyer is where they started.
            Assert.Equal(buyerBefore + 8 + 2.40m, await BalanceAsync(factory, buyer));

            Assert.Equal(2, (await AuditAsync(factory, box.TenantId, "booking.displaced")).Count);
            var reversal = Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
            Assert.Contains(b.BookingId.ToString(), reversal.DetailsJson);
            Assert.Contains(c.BookingId.ToString(), reversal.DetailsJson);
            Assert.Equal(2, mail.Sent.Count(m => m.Subject.StartsWith("Booking refunded", StringComparison.Ordinal)));

            // A's own reversal is untouched by the displacement rows.
            await AssertReversedLedgerAsync(factory, booked.BookingId);
        }

        /// <summary>
        /// A booking on the tail that somebody DID check in on is not displaced — two people
        /// cannot both have played and the ledger is not the place to guess — and A's end is
        /// restored only up to it.
        /// </summary>
        [SkippableFact]
        public async Task A_checked_in_booking_on_the_tail_survives_and_bounds_the_restored_end()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);
            var buyer = await AnotherMemberAsync(factory, box);
            var d = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var row = await db.Bookings.IgnoreQueryFilters().SingleAsync(x => x.Id == d.BookingId);
                row.CheckedInAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync();
            }

            await using var quiet = Quiet(factory, new StubEmailService());
            Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

            var a = await BookingAsync(factory, booked.BookingId);
            var survivor = await BookingAsync(factory, d.BookingId);
            Assert.Equal(BookingStatus.Booked, survivor.Status);
            Assert.Equal(BookingStatus.Booked, a.Status);
            Assert.Equal(survivor.StartsAt, a.EndsAt);
            Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.displaced"));
            Assert.Contains(d.BookingId.ToString(), Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed")).DetailsJson);
        }

        /// <summary>
        /// The box let somebody in ahead of the cue window — its clock or its cached window
        /// drifted. The cue rule is the rule: receipted and acknowledged, audited as too early,
        /// nothing stamped.
        /// </summary>
        [SkippableFact]
        public async Task Activation_event_ahead_of_cue_window_is_not_stamped()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            // Inside the forward window (120) but well ahead of the cue (10).
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 60);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

            var booking = await BookingAsync(factory, booked.BookingId);
            Assert.Null(booking.CheckedInAt);
            Assert.Null(booking.LightsOnCuedAt);
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "court.activated"));
        }

        /// <summary>
        /// The relay the box lit is not wired to the booking's court: a stale or wrong court list
        /// on the box. Acknowledged, audited, not stamped — the member is standing on a court
        /// they did not book.
        /// </summary>
        [SkippableFact]
        public async Task Activation_event_on_a_relay_not_wired_to_the_bookings_court_is_not_stamped()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -2);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));   // relay A is court 1
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            Assert.Null((await BookingAsync(factory, booked.BookingId)).CheckedInAt);
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_wrong_court"));
        }

        /// <summary>
        /// Club B's roster token, reported by club A's box. The code resolver is filtered by
        /// tenant, so at club A it is simply unknown: acknowledged, audited as unresolved, and
        /// club B's booking is untouched.
        /// </summary>
        [SkippableFact]
        public async Task Activation_event_citing_another_clubs_code_stamps_nothing()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var boxA = await SeedAsync(factory);
            var boxB = await SeedAsync(factory);
            var bookedB = await BookAsync(factory, boxB, courtNumber: 1, startsInMinutes: -2);

            var response = await factory.CreateClient().SendAsync(
                FromBox(boxA, EventsPath, Batch(Activation(1, subject: bookedB.Code, court: 0))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

            Assert.Null((await BookingAsync(factory, bookedB.BookingId)).CheckedInAt);
            Assert.Single(await AuditAsync(factory, boxA.TenantId, "device.activation_unresolved"));
            Assert.Empty(await AuditAsync(factory, boxB.TenantId, "court.activated"));
            Assert.Empty(await AuditAsync(factory, boxA.TenantId, "court.activated"));
        }
    }
}
