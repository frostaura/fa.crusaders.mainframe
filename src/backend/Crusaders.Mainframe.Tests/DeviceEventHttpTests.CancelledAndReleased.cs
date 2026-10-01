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
    /// <summary>Lights on a cancelled booking are charged; a relay release settles, narrows or corrects what was charged.</summary>
    public sealed class CancelledAndReleased(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// Book, cancel (full refund), walk in during a WiFi drop: the box's roster still
        /// carries the code and lights the court for the slot. "Nothing back once the lights
        /// have been on" — the lit time is charged pro rata as a LightsPurchase, separate from
        /// the refund, audited as activation_after_cancel, once per booking, and the member
        /// is told. The refund itself is never edited.
        ///
        /// <para>
        /// <b>The billed minutes are the sold window, not the grant</b> (settlement model I6,
        /// round-3 finding 3). The member scanned three minutes before the slot — inside the cue
        /// window, which is where the roster's own window opens — and the box granted sixty
        /// minutes on a forty-five-minute booking. Forty-five is billed. The old arithmetic took
        /// <c>min(grant, OriginalEndsAt − scan)</c> with no lower bound at <c>StartsAt</c> and no
        /// cap at the sold minutes, and billed forty-eight.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task Activation_for_a_booking_cancelled_after_its_code_was_pushed_charges_the_lit_time()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);   // 45 min, 45 minutes charged
            await CancelAsync(factory, box, booked.BookingId);
            Assert.Equal(200, await BalanceAsync(factory, box.MemberId));   // charged 45, refunded 45

            var mail = new StubEmailService();
            await using var quiet = Quiet(factory, mail);
            var client = quiet.CreateClient();

            // The box granted sixty minutes from a window that opened before the slot did.
            var response = await client.SendAsync(FromBox(box, EventsPath,
                Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 3_600_000))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

            var booking = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.Cancelled, booking.Status);
            Assert.Null(booking.CheckedInAt);

            var ledger = await LedgerAsync(factory, booked.BookingId);
            var lit = Assert.Single(ledger, l => l.Type == LedgerEntryType.LightsPurchase);
            Assert.Equal(-45, lit.AmountMinutes);                                     // the 45 sold minutes, not 48 granted
            Assert.Equal(BookingService.CancelledLightsReference(booked.BookingId), lit.ExternalReference);
            Assert.Single(ledger, l => l.Type == LedgerEntryType.CancellationRefund);   // the refund stands, un-netted
            Assert.Equal(200 - 45, await BalanceAsync(factory, box.MemberId));

            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_after_cancel"));
            Assert.Single(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_charged"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_not_chargeable"));
            Assert.Contains(mail.Sent, m => m.Subject.StartsWith("Lights charged", StringComparison.Ordinal));

            // A rescan is another event, not another charge.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Activation(2, subject: booked.Code, court: 0, durationMs: 3_600_000))))).StatusCode);
            Assert.Single(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
            Assert.Equal(200 - 45, await BalanceAsync(factory, box.MemberId));
        }

        /// <summary>The correction is posted whatever the balance: a member who spent the refund goes negative.</summary>
        [SkippableFact]
        public async Task The_cancelled_lights_charge_is_posted_even_when_the_balance_cannot_cover_it()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, topUpMinutes: 45);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);
            await CancelAsync(factory, box, booked.BookingId);
            using (var scope = factory.Services.CreateScope())
            {
                // The refund is spent elsewhere before the box reconnects.
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.LedgerEntries.Add(new LedgerEntry { TenantId = box.TenantId, UserId = box.MemberId, Type = LedgerEntryType.BookingCharge, AmountMinutes = -20, ActorUserId = box.MemberId, Reason = "elsewhere" });
                await db.SaveChangesAsync();
            }
            Assert.Equal(25, await BalanceAsync(factory, box.MemberId));

            await using var quiet = Quiet(factory, new StubEmailService());
            Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 3_600_000))))).StatusCode);

            Assert.Equal(25 - 45, await BalanceAsync(factory, box.MemberId));
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_after_cancel"));
        }

        // ---- the settlement model (docs/specs/settlement-model.md) ----------------------

        /// <summary>
        /// Settlement model I1 and I7. A booking cancelled inside the penalty window has already
        /// cost its member the penalty; the club keeps it. When the box then lights the court
        /// from a stale roster, the lit time is charged <b>on top of</b> that — so it has to be
        /// netted, or the booking costs more than it ever could have.
        ///
        /// <para>
        /// Round-3 finding 3: a 45-minute court, a 30% penalty retained, and the full price charged
        /// again for the lights — 130% of the court, with an email telling the member so. The
        /// ceiling is the price: a penalty of 13 (30% of 45 is 13.5, rounded down in the member's
        /// favour) and 32 for the lights, 45 in all.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_retained_late_cancellation_penalty_is_netted_against_the_lit_charge()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            // Starts in two minutes — inside the default fifteen-minute penalty window, and late
            // enough that a scan five minutes ago is still inside the cue window.
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 2);
            var cancellation = await CancelAsync(factory, box, booked.BookingId, waivePenalty: false);
            Assert.Equal(45, cancellation.RefundedMinutes);
            Assert.Equal(13, cancellation.PenaltyMinutes);
            Assert.Equal(200 - 13, await BalanceAsync(factory, box.MemberId));

            await using var quiet = Quiet(factory, new StubEmailService());
            Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
                Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 3_600_000))))).StatusCode);

            var lit = Assert.Single(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
            Assert.Equal(-32, lit.AmountMinutes);                           // 45 gross, capped at 45 − 13
            Assert.Equal(200 - 45, await BalanceAsync(factory, box.MemberId));   // the booking cost exactly its price
        }

        /// <summary>
        /// Settlement model I7. The cue gate was applied on the no-show branch and not on the
        /// cancelled one directly below it, which made the cancelled-then-lit charge the one
        /// path a box with a drifted clock could still spend a member's minutes down.
        /// </summary>
        [SkippableFact]
        public async Task A_cancelled_booking_scanned_before_the_cue_window_is_not_charged()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 60);
            await CancelAsync(factory, box, booked.BookingId);
            Assert.Equal(200, await BalanceAsync(factory, box.MemberId));

            // Scanned five minutes ago — sixty-five minutes before a cue window that opens ten
            // minutes before the slot.
            await using var quiet = Quiet(factory, new StubEmailService());
            Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
                Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

            Assert.DoesNotContain(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
            Assert.Equal(200, await BalanceAsync(factory, box.MemberId));
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_charged"));
        }

        /// <summary>
        /// Settlement model I5 — round-3 finding 16. B's booking was cancelled by the system so
        /// that A's late attendance evidence could have the court, and B was refunded and emailed
        /// to say so. B walks in anyway, the box's cached roster still carries B's code, the
        /// court lights. B must not be billed pro rata for it: that is two members charged for
        /// one court, and the second of them for a booking they never cancelled.
        /// </summary>
        [SkippableFact]
        public async Task A_displaced_bookings_own_late_scan_is_not_charged()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);
            var buyer = await AnotherMemberAsync(factory, box);
            var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 1, minutes: 15, mintCode: true);

            await using var quiet = Quiet(factory, new StubEmailService());
            var client = quiet.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

            var displaced = await BookingAsync(factory, b.BookingId);
            Assert.Equal(BookingStatus.Cancelled, displaced.Status);
            Assert.Equal(BookingService.ResoldTailRefunded, displaced.CancellationReason);
            Assert.Equal(booked.BookingId, displaced.DisplacedByBookingId);
            var buyerAfterDisplacement = await BalanceAsync(factory, buyer);

            // The code died with the displacement, so no box gets it on its next roster either.
            Assert.False(await CodeIsLiveAsync(factory, b.Code));

            // B's own queued scan arrives.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
                FromBox(box, EventsPath, Batch(Activation(2, subject: b.Code, court: 0))))).StatusCode);

            Assert.DoesNotContain(await LedgerAsync(factory, b.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
            Assert.Equal(buyerAfterDisplacement, await BalanceAsync(factory, buyer));
            var collision = Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_displaced_collision"));
            Assert.Contains(booked.BookingId.ToString(), collision.DetailsJson);   // names what displaced it
            Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_charged"));
        }

        /// <summary>
        /// Settlement model I10. A booking nobody was ever charged for is displaced like any
        /// other, but there is nothing to give back — and a zero-credit row is not a refund. It
        /// moves no money, burns the idempotency reference the real posting would have needed,
        /// and reads on a statement as a movement that did not happen.
        /// </summary>
        [SkippableFact]
        public async Task A_never_charged_displaced_booking_posts_no_zero_credit_row()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);
            var buyer = await AnotherMemberAsync(factory, box);
            var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15, charged: false);

            await using var quiet = Quiet(factory, new StubEmailService());
            Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

            Assert.Equal(BookingStatus.Cancelled, (await BookingAsync(factory, b.BookingId)).Status);
            Assert.Empty(await LedgerAsync(factory, b.BookingId));
            Assert.Single(await AuditAsync(factory, box.TenantId, "booking.displaced"));
        }

        /// <summary>
        /// Settlement model I6 — the early OFF. The activation carries the <i>grant</i>; only the
        /// release carries the measurement. A member who plays five minutes of a twenty-minute
        /// grant and presses OFF is charged five, and the difference comes back.
        ///
        /// <para>
        /// The two events go up in <b>separate requests</b>, because that is how the box works:
        /// <c>drainEvents</c> uploads one event per pass, so a release is always at least one
        /// request behind the activation it belongs to and can never be settled with it.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_release_reduces_a_cancelled_lit_charge_to_what_the_relay_measured()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
            await CancelAsync(factory, box, booked.BookingId);

            await using var quiet = Quiet(factory, new StubEmailService());
            var client = quiet.CreateClient();

            // Scan five minutes ago, granted twenty minutes.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 1_200_000))))).StatusCode);
            Assert.Equal(-20, Assert.Single(await LedgerAsync(factory, booked.BookingId),
                l => l.Type == LedgerEntryType.LightsPurchase).AmountMinutes);

            // The next request carries the release: the relay was closed for five minutes.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Release(2, court: 0, heldMs: 300_000))))).StatusCode);

            var lights = (await LedgerAsync(factory, booked.BookingId)).Where(l => l.Type == LedgerEntryType.LightsPurchase).ToList();
            Assert.Equal(2, lights.Count);
            Assert.Equal(15, Assert.Single(lights, l => l.AmountMinutes > 0).AmountMinutes);
            Assert.Equal(-5, lights.Sum(l => l.AmountMinutes));              // the 5 minutes the relay measured
            Assert.Single(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_adjusted"));

            // A second release does not pay it back twice.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Release(3, court: 0, heldMs: 300_000))))).StatusCode);
            Assert.Equal(-5, (await LedgerAsync(factory, booked.BookingId))
                .Where(l => l.Type == LedgerEntryType.LightsPurchase).Sum(l => l.AmountMinutes));
        }

        /// <summary>
        /// Settlement model I8/I9 — round-3 finding 14. A played twenty minutes offline and
        /// pressed OFF; the sweep had already released the tail and B bought part of it. The
        /// reversal displaces B on the grant, because at that instant the court is believed lit
        /// to the end of the slot and two members on one court is the worse error. The release
        /// arrives one request later and proves otherwise: A's end is narrowed to what the relay
        /// measured, and B — whose slot has not started — gets their booking back.
        /// </summary>
        [SkippableFact]
        public async Task The_release_narrows_the_reversed_window_and_reinstates_the_displaced_booking()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);
            var buyer = await AnotherMemberAsync(factory, box);
            var buyerBefore = await BalanceAsync(factory, buyer);
            var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);
            Assert.Equal(buyerBefore - 15, await BalanceAsync(factory, buyer));

            var mail = new StubEmailService();
            await using var quiet = Quiet(factory, mail);
            var client = quiet.CreateClient();

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);
            Assert.Equal(BookingStatus.Cancelled, (await BookingAsync(factory, b.BookingId)).Status);
            Assert.Equal(buyerBefore, await BalanceAsync(factory, buyer));      // refunded on the grant

            // The relay was closed for five minutes, ending at the upload instant — well before
            // B's slot. One request later, as the box sends it.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
                FromBox(box, EventsPath, Batch(Release(2, court: 0, heldMs: 300_000))))).StatusCode);

            var a = await BookingAsync(factory, booked.BookingId);
            var reinstated = await BookingAsync(factory, b.BookingId);
            Assert.Equal(BookingStatus.Booked, reinstated.Status);
            Assert.Null(reinstated.CancellationReason);
            Assert.Null(reinstated.DisplacedByBookingId);
            Assert.True(a.EndsAt <= reinstated.StartsAt, $"A's end {a.EndsAt} must clear B's start {reinstated.StartsAt}");

            // Charged once for a booking they get to keep.
            Assert.Equal(buyerBefore - 15, await BalanceAsync(factory, buyer));
            var refunds = (await LedgerAsync(factory, b.BookingId)).Where(l => l.Type == LedgerEntryType.CancellationRefund).ToList();
            Assert.Equal(2, refunds.Count);
            Assert.Equal(0, refunds.Sum(l => l.AmountMinutes));

            Assert.Single(await AuditAsync(factory, box.TenantId, "booking.lit_window_narrowed"));
            Assert.Single(await AuditAsync(factory, box.TenantId, "booking.displacement_reversed"));
            Assert.Contains(mail.Sent, m => m.Subject.StartsWith("Booking reinstated", StringComparison.Ordinal));
            Assert.True(await BookingHasLiveCodeAsync(factory, b.BookingId), "a reinstated booking gets a fresh access code");
        }

        /// <summary>
        /// A release that names no session it can reconcile with corrects nothing. The pairing is
        /// by device, relay and time, and a release arriving with no activation behind it — the
        /// first event after a reboot, or one whose activation was dropped — must not be allowed
        /// to re-price whatever happened to be lit on that relay last.
        /// </summary>
        [SkippableFact]
        public async Task A_release_with_no_activation_behind_it_settles_nothing()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
            await CancelAsync(factory, box, booked.BookingId);

            await using var quiet = Quiet(factory, new StubEmailService());
            var client = quiet.CreateClient();

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Release(1, court: 0, heldMs: 300_000))))).StatusCode);
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.release_unpaired"));
            Assert.DoesNotContain(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);

            // And the ordinary order still works: the activation first, the release behind it.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Activation(2, subject: booked.Code, court: 0, durationMs: 1_200_000))))).StatusCode);
            Assert.Equal(-20, Assert.Single(await LedgerAsync(factory, booked.BookingId),
                l => l.Type == LedgerEntryType.LightsPurchase).AmountMinutes);

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Release(3, court: 0, heldMs: 300_000))))).StatusCode);
            Assert.Equal(-5, (await LedgerAsync(factory, booked.BookingId))
                .Where(l => l.Type == LedgerEntryType.LightsPurchase).Sum(l => l.AmountMinutes));
        }

        /// <summary>
        /// Settlement model I8. The reversal displaces what the court could have reached, not the
        /// whole slot. A box that granted fifteen minutes cannot have been lighting the court an
        /// hour later, so a booking beyond the grant is nobody's collision — it used to be
        /// cancelled, refunded and emailed anyway, and the slot then sat dark and unsellable
        /// (round-3 finding 14).
        /// </summary>
        [SkippableFact]
        public async Task A_reversal_displaces_only_what_the_grant_could_have_reached()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);        // A: −10, 45 min, tail [now, +35)
            var buyer = await AnotherMemberAsync(factory, box);
            var buyerBefore = await BalanceAsync(factory, buyer);
            var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);

            // The box lit the court for fifteen minutes from a scan five minutes ago: it went
            // dark around ten minutes from now, long before B's slot.
            var mail = new StubEmailService();
            await using var quiet = Quiet(factory, mail);
            Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
                Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 900_000))))).StatusCode);

            var survivor = await BookingAsync(factory, b.BookingId);
            Assert.Equal(BookingStatus.Booked, survivor.Status);
            Assert.Null(survivor.CancellationReason);
            Assert.Equal(buyerBefore - 15, await BalanceAsync(factory, buyer));   // charged once, untouched
            Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.displaced"));
            Assert.DoesNotContain(mail.Sent, m => m.Subject.StartsWith("Booking refunded", StringComparison.Ordinal));

            // A's end is the window the grant reached, not the end of the slot it was sold.
            var a = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(BookingStatus.Booked, a.Status);
            Assert.True(a.EndsAt < BookingService.OriginalEndsAt(a),
                $"the restored end {a.EndsAt} must stop short of the sold end {BookingService.OriginalEndsAt(a)}");
            Assert.True(a.EndsAt <= survivor.StartsAt);
        }

        /// <summary>
        /// A release names no session, so it is paired by device, relay and time — and a pairing
        /// that does not reconcile corrects <b>nothing</b>. Without the check, a release whose
        /// activation was dropped re-prices whatever was lit on that relay last, in the member's
        /// favour or against them depending on an accident.
        /// </summary>
        [SkippableFact]
        public async Task A_release_that_does_not_reconcile_with_its_session_corrects_nothing()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
            await CancelAsync(factory, box, booked.BookingId);

            await using var quiet = Quiet(factory, new StubEmailService());
            var client = quiet.CreateClient();

            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 1_200_000))))).StatusCode);
            Assert.Equal(-20, Assert.Single(await LedgerAsync(factory, booked.BookingId),
                l => l.Type == LedgerEntryType.LightsPurchase).AmountMinutes);

            // One held minute, uploaded five minutes after the scan: the implied end is four
            // minutes adrift of the release's own time, so these two are not a pair.
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
                Batch(Release(2, court: 0, heldMs: 60_000))))).StatusCode);

            Assert.Single(await AuditAsync(factory, box.TenantId, "device.release_unpaired"));
            Assert.Equal(-20, Assert.Single(await LedgerAsync(factory, booked.BookingId),
                l => l.Type == LedgerEntryType.LightsPurchase).AmountMinutes);
            Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_adjusted"));
        }
    }
}
