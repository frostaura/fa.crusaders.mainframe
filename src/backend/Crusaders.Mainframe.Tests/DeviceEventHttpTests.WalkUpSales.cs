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
    /// <summary>Walk-ups sold at the box: what is booked, how it is truncated and priced, and when it is refused.</summary>
    public sealed class WalkUpSales(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- buying court time at the box -------------------------------------

        [SkippableFact]
        public async Task A_walk_up_creates_a_real_booking_charges_it_and_lights_the_court()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(30, body.GetProperty("granted_minutes").GetInt32());
            // A whole number of minutes on the wire, never 30.0 (contract §1.1).
            Assert.Equal(JsonValueKind.Number, body.GetProperty("amount_minutes").ValueKind);
            Assert.Equal("30", body.GetProperty("amount_minutes").GetRawText());
            Assert.False(body.GetProperty("replayed").GetBoolean());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var booking = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.UserId == box.MemberId);

            // A real booking in the member's name, visible online immediately — one money path,
            // not two — and checked in, because they are standing on the court.
            Assert.Equal(BookingStatus.Booked, booking.Status);
            Assert.NotNull(booking.ChargedAt);
            Assert.NotNull(booking.CheckedInAt);
        }

        [SkippableFact]
        public async Task A_walk_up_is_truncated_at_the_next_booking_and_charged_pro_rata()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var startsAt = DateTimeOffset.UtcNow.AddMinutes(20).AddSeconds(30);
                db.Bookings.Add(new Booking
                {
                    TenantId = box.TenantId,
                    CourtId = box.CourtId,
                    UserId = Guid.NewGuid(),
                    ActorUserId = Guid.NewGuid(),
                    StartsAt = startsAt,
                    EndsAt = startsAt.AddMinutes(30),
                    SliceMinutes = 15,
                    SliceCount = 2,
                    AmountChargedMinutes = 30,
                    Status = BookingStatus.Booked,
                    ChargedAt = DateTimeOffset.UtcNow,
                });
                await db.SaveChangesAsync();
            }

            var client = factory.CreateClient();
            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 60)));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();

            // Twenty minutes and thirty seconds is all there is to sell: the box is granted the
            // whole 20 and charged 20 — the part-minute stays with the member (§1.2), and the
            // charge is not a slice count rounded up (that would be 30).
            Assert.Equal(20, body.GetProperty("granted_minutes").GetInt32());
            Assert.Equal(20, body.GetProperty("amount_minutes").GetInt32());
        }

        /// <summary>
        /// The zone <see cref="SeedAsync"/> puts a club in is the whole reason the walk-up tests
        /// in this class are not a lottery, and nothing asserted that it happens.
        ///
        /// <para>
        /// It is written to fail at <b>every</b> hour rather than only at the unlucky ones, the
        /// same way <c>WalkUpBookingTests.Clearing_the_club_of_closing_actually_writes_the_zone</c>
        /// is: the old seed wrote the literal <c>"UTC"</c> and
        /// <see cref="TestHost.DayZoneFor"/> never returns that string — its zero-offset answer
        /// is the tzdb id <c>Etc/UTC</c>. So a revert to the old literal is red at noon, not
        /// just at ten to midnight, which is the difference between a pin and a coin toss.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_seeded_club_sits_where_a_full_walk_up_still_fits_before_it_closes()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var written = JsonNode
                .Parse((await db.TenantSettings.IgnoreQueryFilters().SingleAsync(t => t.TenantId == box.TenantId))
                    .SettingsJson)!["timezone"]!.GetValue<string>();

            Assert.NotEqual("UTC", written);
            Assert.Equal(box.Timezone, written);

            // Read back through the tzdb, not through DayZoneFor's own arithmetic: Etc/GMT+n is
            // UTC MINUS n, and a helper with that sign inverted would agree with itself.
            var local = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById(written));
            var minuteOfDay = (local.Hour * 60) + local.Minute;
            Assert.InRange(minuteOfDay, 60, (24 * 60) - RelayHardCap.Minutes - 60);
        }

        /// <summary>
        /// Closing time truncates a walk-up and the price follows it, pinned on purpose instead
        /// of being met once a day by accident.
        ///
        /// <para>
        /// <b>The rule had a test; the money did not.</b>
        /// <c>OperatingHoursTests.A_walk_up_is_truncated_at_closing_time_rather_than_selling_the_night</c>
        /// proves the truncation at the service level, in a window of "roughly ten minutes", with
        /// <c>Assert.InRange(minutes, 1, 11)</c> and no assertion about price at all. What was
        /// untested is the pair the box actually receives — <c>granted_minutes</c> and
        /// <c>amount_minutes</c> together, over HTTP, against a named closing instant. Five tests
        /// in this class met that pair by accident: they asserted a
        /// figure and got what was left of the club's day instead, for the last half-hour of
        /// every UTC day. At 23:51 UTC on 2026-09-07 the box sold eight minutes for 4.27 of the old credits,
        /// and the failures read as four unrelated bugs: a balance of 195.73 against an expected
        /// 184, a grant of 8 against 30, a grant of 8 against 20, and a member with 5 credits
        /// being SOLD a court the test expects to be refused — because 4.27 is inside 5.00. Not
        /// one of them named closing time. <see cref="SeedAsync"/> now keeps
        /// them away from closing time, so this is the test that says what happens when a
        /// purchase genuinely does reach it, and it says so at every hour: the club's closing
        /// minute is set relative to the club's own current minute, so "closes in twenty
        /// minutes" means that whenever the suite runs.
        /// </para>
        ///
        /// <para>
        /// The granted figure is allowed one minute of width because the boundary is sub-minute
        /// and <c>day_end_minute</c> can only be a whole minute: the sale is floored to whole
        /// minutes and closing time lands part-way through one, so a window of twenty grants
        /// nineteen or twenty depending on where in the minute the request arrives. The <b>price
        /// is not</b> — it is asserted exactly against the minutes actually granted, which is
        /// where the money is, and against the closing instant the booking was cut to.
        /// </para>
        ///
        /// <para>
        /// <b>The expectation is measured, not assumed, and that is the second time this fixture
        /// taught the same lesson.</b> Written against the <c>closesInMinutes</c> constant, this
        /// test went red once in a twenty-four-run synthetic-clock sweep — the (30, 60) case, on
        /// a loaded machine, granted 28 because more than a minute of wall clock passed between
        /// <see cref="CloseInAsync"/> setting the window and the request reaching the handler. It
        /// was green because the machine was fast, which is the same defect as being green
        /// because of the hour. It now reads the clock immediately before the request and expects
        /// what was actually left at that instant.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData(150, 90)]   // the whole hard cap fits: nothing is truncated
        [InlineData(120, 30)]
        [InlineData(31, 30)]    // one minute of headroom: still the full sale
        [InlineData(30, 60)]    // 29 or 30 minutes, charged exactly that
        [InlineData(20, 60)]    // the figure the truncation test above asserts
        [InlineData(7, 30)]     // a few minutes, still whole
        public async Task A_walk_up_is_truncated_at_closing_time_and_charged_pro_rata(int closesInMinutes, int requestedMinutes)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var closesAt = await CloseInAsync(factory, box, closesInMinutes);
            var client = factory.CreateClient();
            var payload = WalkUp(await QrCodeAsync(factory, box), minutes: requestedMinutes);

            // Everything slow is now behind us; whatever is left of the window at THIS instant is
            // what the sale may be worth.
            var askedAt = DateTimeOffset.UtcNow;
            var response = await client.SendAsync(FromBox(box, WalkUpPath, payload));

            var windowMinutes = (int)Math.Floor((closesAt - askedAt).TotalMinutes);
            Assert.True(
                windowMinutes >= 1,
                $"the fixture took longer to set up than the {closesInMinutes}-minute window it was setting up");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            var granted = body.GetProperty("granted_minutes").GetInt32();
            var truncated = windowMinutes <= requestedMinutes;

            if (truncated)
            {
                Assert.InRange(granted, windowMinutes - 1, windowMinutes);
            }
            else
            {
                Assert.Equal(requestedMinutes, granted);
            }

            // A minute of court costs a minute: the charge is exactly the whole minutes granted.
            Assert.Equal(granted, body.GetProperty("amount_minutes").GetInt32());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var booking = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.UserId == box.MemberId);

            // Cut to CLOSING TIME specifically, not merely to something short: a booking that
            // ended anywhere else would satisfy the minute count above just as well.
            if (truncated)
            {
                Assert.InRange(booking.EndsAt, closesAt.AddMinutes(-1), closesAt);
            }
            else
            {
                Assert.True(booking.EndsAt < closesAt, "an untruncated sale still ends before the club closes");
            }
        }

        [SkippableFact]
        public async Task A_walk_up_the_member_cannot_afford_is_refused_with_the_numbers()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, topUpMinutes: 5);
            var client = factory.CreateClient();

            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box))));

            Assert.Equal(HttpStatusCode.PaymentRequired, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            // Both numbers, so the box can say "5 of 30" rather than "no".
            Assert.Equal(5, body.GetProperty("current_minutes").GetInt32());
            Assert.Equal(30, body.GetProperty("required_minutes").GetInt32());
        }

        [SkippableFact]
        public async Task A_walk_up_on_a_court_someone_is_already_playing_on_is_refused()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.Bookings.Add(new Booking
                {
                    TenantId = box.TenantId,
                    CourtId = box.CourtId,
                    UserId = Guid.NewGuid(),
                    ActorUserId = Guid.NewGuid(),
                    StartsAt = DateTimeOffset.UtcNow.AddMinutes(-5),
                    EndsAt = DateTimeOffset.UtcNow.AddMinutes(25),
                    SliceMinutes = 15,
                    SliceCount = 2,
                    AmountChargedMinutes = 30,
                    Status = BookingStatus.Booked,
                    ChargedAt = DateTimeOffset.UtcNow,
                });
                await db.SaveChangesAsync();
            }

            var client = factory.CreateClient();
            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box))));

            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("court_in_use", body.GetProperty("error").GetString());
        }

        /// <summary>
        /// A box sells time on the courts it drives and no other. The request names the court
        /// now — it has to, one box drives four relays (review C5) — and a court outside the
        /// box's list is refused before anything is booked. A box that could name any court is
        /// a box that opens any court in the club.
        /// </summary>
        [SkippableFact]
        public async Task A_box_sells_time_on_its_own_courts_and_no_other()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.Courts.Add(new Court { TenantId = box.TenantId, CourtNumber = 2, Name = "Court 2" });
                await db.SaveChangesAsync();
            }

            var client = factory.CreateClient();
            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), court: 2)));

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("court_not_on_device", body.GetProperty("error").GetString());

            using var check = factory.Services.CreateScope();
            var db2 = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db2.Bookings.IgnoreQueryFilters().Where(b => b.UserId == box.MemberId).ToListAsync());
        }

        /// <summary>
        /// A walk-up at a shut club names the hours. It used to collapse into the catch-all
        /// <c>walk_up_refused</c>, throwing away the two times the member needs — and, because
        /// that code is in no firmware table either, painting SEE THE DESK at a locked club
        /// after hours, when there is no desk. The Settings page promises the API enforces these
        /// hours; this is the half of that promise the box could not keep.
        /// </summary>
        [SkippableFact]
        public async Task A_walk_up_at_a_closed_club_is_refused_with_the_opening_hours()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (opensAt, closesAt) = await CloseTheClubAsync(factory, box);

            var response = await factory.CreateClient().SendAsync(
                FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("club_closed", body.GetProperty("error").GetString());
            Assert.Equal(opensAt, body.GetProperty("opens_at").GetString());
            Assert.Equal(closesAt, body.GetProperty("closes_at").GetString());

            // Refused, so nothing was sold and nothing was charged.
            Assert.Equal(200, await BalanceAsync(factory, box.MemberId));
        }

        // ---- the club's walk-up cap reaches the box (finding M-F1) ------------------------

        /// <summary>
        /// The heartbeat carries the longest walk-up this club will sell, so the box is never
        /// advertising a minute button the API is about to refuse. A club that lowered its cap
        /// to 20 left every box showing 15/30/45/60 and three of the four pressing through to
        /// <c>minutes_out_of_range</c> — a configuration change the member got blamed for. The
        /// number is the same bound the walk-up applies, <c>min(club cap, relay hard cap)</c>,
        /// so the two cannot disagree.
        /// </summary>
        [SkippableTheory]
        [InlineData(null, RelayHardCap.Minutes)]
        [InlineData(20, 20)]
        [InlineData(60, 60)]
        public async Task Heartbeat_carries_the_clubs_walk_up_maximum(int? configured, int expected)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);

            if (configured is { } cap)
            {
                using var scope = factory.Services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(t => t.TenantId == box.TenantId);
                row.SettingsJson = row.SettingsJson.TrimEnd('}') + $",\"walk_up_max_minutes\":{cap}}}";
                await db.SaveChangesAsync();
            }

            var body = await HeartbeatAsync(factory, box);

            Assert.Equal(expected, body.GetProperty("config").GetProperty("walk_up_max_minutes").GetInt32());

            // And it is the number the walk-up itself enforces, not a second opinion: one more
            // minute than the advertised cap is refused with that same figure.
            var refusal = await factory.CreateClient().SendAsync(
                FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: expected + 1)));
            Assert.Equal(HttpStatusCode.BadRequest, refusal.StatusCode);
            var refused = await refusal.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("minutes_out_of_range", refused.GetProperty("error").GetString());
            Assert.Equal(expected, refused.GetProperty("max_minutes").GetInt32());
        }
    }
}
