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
    /// <summary>Only active members buy or light court time at the box, and every scan counts as the box reporting.</summary>
    public sealed class MemberStatus(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// A box that is switching courts on is not silent. <c>LastSeenAt</c> moved on
        /// <c>/heartbeat</c> and <c>/events</c> only, so a box whose periodic POST had stalled
        /// while request/response still worked was alerted on as "not reporting" mid-scan, shown
        /// as "last seen 11m ago" beside a court it had just lit, and — through §6a — had that
        /// court's no-show penalties waived. Every device call is liveness now, and the silence
        /// it ended is recorded on the way past, exactly as the heartbeat records it.
        /// </summary>
        [SkippableFact]
        public async Task Lighting_a_booked_court_counts_as_the_box_reporting()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 1);
            var quietAt = await WentQuietAsync(factory, box, minutes: 20);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, ActivatePath, new { method = "qr", token = booked.Code }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            Assert.Equal(DateTimeOffset.UtcNow, (await DeviceAsync(factory, box)).LastSeenAt!.Value, TimeSpan.FromMinutes(1));

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var outage = Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().Where(o => o.DeviceId == box.DeviceId).ToListAsync());
            Assert.Equal(quietAt, outage.StartedAt, TimeSpan.FromSeconds(1));
            Assert.NotNull(outage.EndedAt);
        }

        /// <summary>
        /// The same for a refusal: the box called, whatever the answer was. Driven with a token
        /// this club has never minted, so nothing else about the request could have moved the row.
        /// </summary>
        [SkippableFact]
        public async Task Even_a_refused_scan_counts_as_the_box_reporting()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            await WentQuietAsync(factory, box, minutes: 20);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, ActivatePath, new { method = "qr", token = "7Q3F9KM2XZ8B" }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("not_recognised", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason").GetString());

            Assert.Equal(DateTimeOffset.UtcNow, (await DeviceAsync(factory, box)).LastSeenAt!.Value, TimeSpan.FromMinutes(1));
        }

        /// <summary>Selling court time is the same evidence, and the same rule.</summary>
        [SkippableFact]
        public async Task Selling_a_walk_up_counts_as_the_box_reporting()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            await WentQuietAsync(factory, box, minutes: 20);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            Assert.Equal(DateTimeOffset.UtcNow, (await DeviceAsync(factory, box)).LastSeenAt!.Value, TimeSpan.FromMinutes(1));
        }

        /// <summary>
        /// Buying court time at the box, by membership state. Only an Active member may;
        /// suspended, rejected and still-awaiting-approval are all refused, and refused
        /// <b>before</b> anything is charged — the whole point is that no money moves.
        ///
        /// <para>
        /// <c>not_recognised</c> is the answer on purpose: it is the one walk-up refusal whose
        /// firmware row carries <c>recognised:false</c>, so no button window is armed for a
        /// barred member, and its screen is SEE THE DESK, which is exactly what they must do.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(MembershipStatus.Active, true)]
        [InlineData(MembershipStatus.Suspended, false)]
        [InlineData(MembershipStatus.Rejected, false)]
        [InlineData(MembershipStatus.PendingApproval, false)]
        public async Task Only_an_active_member_can_buy_court_time_at_the_box(MembershipStatus status, bool sold)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            await SetMembershipAsync(factory, box, status);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));

            if (sold)
            {
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.Equal(184, await BalanceAsync(factory, box.MemberId));
                return;
            }

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("not_recognised", body.GetProperty("error").GetString());

            // No booking, no debit, no lit court. A refusal that arrives after the charge is a
            // refund to write rather than a sale not made.
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db.Bookings.IgnoreQueryFilters().Where(b => b.UserId == box.MemberId).ToListAsync());
            Assert.Equal(200, await BalanceAsync(factory, box.MemberId));
        }

        /// <summary>
        /// The second door. A booking-activation code names its booking outright, so
        /// <c>ForBookingCodeAsync</c> looked the row up by id and never met the candidate-set
        /// filter that drops a barred member — a suspended member's own code lit their court and
        /// charged them for it. Answered <c>no_booking</c>, the same sentence the ident-code
        /// branch has always given, because a box that named the suspension would be announcing
        /// it to whoever is standing at the court.
        /// </summary>
        [SkippableTheory]
        [InlineData(MembershipStatus.Active, true)]
        [InlineData(MembershipStatus.Suspended, false)]
        [InlineData(MembershipStatus.Rejected, false)]
        [InlineData(MembershipStatus.PendingApproval, false)]
        public async Task Only_an_active_member_can_light_a_booked_court_from_the_box(MembershipStatus status, bool lit)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 1);
            await SetMembershipAsync(factory, box, status);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, ActivatePath, new { method = "qr", token = booked.Code }));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(lit, body.GetProperty("activated").GetBoolean());
            Assert.Equal(lit ? "ok" : "no_booking", body.GetProperty("reason").GetString());

            var after = await BookingAsync(factory, booked.BookingId);
            Assert.Equal(lit, after.CheckedInAt is not null);
        }

        /// <summary>
        /// The same door with the other kind of code. A member-ident code searches the box's
        /// courts through <c>FindForUserAsync</c>, which has carried the filter all along — this
        /// pins that it still does, so a later tidy-up of the two branches cannot quietly drop
        /// one of them.
        /// </summary>
        [SkippableTheory]
        [InlineData(MembershipStatus.Active, true)]
        [InlineData(MembershipStatus.Suspended, false)]
        public async Task Only_an_active_member_can_light_a_booked_court_with_an_ident_code(MembershipStatus status, bool lit)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 1);
            await SetMembershipAsync(factory, box, status);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, ActivatePath, new { method = "qr", token = await QrCodeAsync(factory, box) }));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(lit, body.GetProperty("activated").GetBoolean());
            Assert.Equal(lit, (await BookingAsync(factory, booked.BookingId)).CheckedInAt is not null);
        }

        /// <summary>
        /// And the cached door: a barred member is off the roster the box decides against while
        /// the link is down. Suspension that held only while the API was reachable would fail in
        /// exactly the window a club most wants it to hold.
        /// </summary>
        [SkippableTheory]
        [InlineData(MembershipStatus.Active, 1)]
        [InlineData(MembershipStatus.Suspended, 0)]
        [InlineData(MembershipStatus.Rejected, 0)]
        [InlineData(MembershipStatus.PendingApproval, 0)]
        public async Task The_roster_carries_only_active_members(MembershipStatus status, int entries)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 5);
            await SetMembershipAsync(factory, box, status);

            var body = await HeartbeatAsync(factory, box);

            Assert.Equal(entries, body.GetProperty("roster").GetArrayLength());
        }

        /// <summary>
        /// The deliberate carve-out, pinned so nobody "completes" the fix by closing it.
        ///
        /// <para>
        /// <c>/events</c> is not the API deciding whether lights come on; it is a report that
        /// they already did. The roster drops a barred member from every push, so the only way
        /// one reaches this handler is a box that admitted them from a cache fetched before the
        /// club's decision — the relay has run and the member has played. Refusing the
        /// attendance would unlight nothing: it would make them a no-show, refund the court they
        /// used and waive the penalty. The money follows the lights, here as everywhere else.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_scan_the_box_had_already_admitted_offline_is_still_recorded_for_a_suspended_member()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -10);
            await SetMembershipAsync(factory, box, MembershipStatus.Suspended);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 1))));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            Assert.NotNull((await BookingAsync(factory, booked.BookingId)).CheckedInAt);

            // And the sweep leaves it alone: no refund of a court that was played on, no waived
            // penalty for the club to absorb.
            await SweepAsync(factory);
            var ledger = await LedgerAsync(factory, booked.BookingId);
            Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.CancellationRefund);
            Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.NoShowPenalty);
        }
    }
}
