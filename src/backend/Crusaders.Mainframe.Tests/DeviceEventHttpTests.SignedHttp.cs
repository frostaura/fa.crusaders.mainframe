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
    /// <summary>Who may buy and activate over the box's signed HTTP: identities, nonces, codes and the heartbeat's roster.</summary>
    public sealed class SignedHttp(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        [SkippableTheory]
        [InlineData("pin")]
        [InlineData("biometric")]
        [InlineData(null)]
        public async Task A_walk_up_by_a_method_that_cannot_identify_globally_is_refused(string? method)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            // A PIN is checked against the handful of members with a booking on this court,
            // which is what makes four digits usable. A walk-up has no booking, so the same
            // check against the whole roll would be a 10,000-space oracle over a club with far
            // fewer than 10,000 members — a random four digits would frequently match somebody.
            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp("1234", method: method)));

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("not_recognised", body.GetProperty("error").GetString());
        }

        /// <summary>
        /// The rule itself, not a consequence of it.
        ///
        /// <para>
        /// The HTTP test below refuses a PIN, but it would refuse any nonsense token — so on its
        /// own it proves "an invalid token is rejected" and not "PIN is not a global method". A
        /// mutation widening <see cref="IdentificationResolver.CanIdentifyGlobally"/> to accept
        /// everything left it green. This is the assertion that actually holds the rule.
        /// </para>
        /// </summary>
        [Theory]
        [InlineData("qr", true)]
        [InlineData("QR", true)]
        [InlineData("code", true)]      // the same code, typed rather than scanned
        [InlineData("pin", false)]
        [InlineData("biometric", false)]
        [InlineData("", false)]
        [InlineData(null, false)]
        public void Only_qr_identifies_a_member_without_a_booking_to_check_against(string? method, bool expected)
        {
            // A PIN is checked against the handful of members with a booking on this court, which
            // is what makes four digits usable at all. A walk-up has no booking, so the same
            // check against the whole roll is a 10,000-space oracle over a club with far fewer
            // than 10,000 members — a random four digits would frequently match somebody.
            Assert.Equal(expected, IdentificationResolver.CanIdentifyGlobally(method));
        }

        /// <summary>
        /// What a walk-up will not take: a code whose lifetime is over, a code another club
        /// minted, and the old JWT — which the box could never scan anyway, but which must not
        /// identify anybody if it somehow arrives. All three land in the same refusal, because
        /// a box that could tell them apart is an oracle for which codes are real.
        /// </summary>
        [SkippableTheory]
        [InlineData("expired")]
        [InlineData("foreign")]
        [InlineData("jwt")]
        public async Task A_walk_up_token_must_be_a_live_code_of_this_club_and_nothing_else(string kind)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            var token = kind switch
            {
                "expired" => await TestAccessCodes.InsertExpiredAsync(factory.Services, box.TenantId, box.MemberId),
                "foreign" => await ForeignCodeAsync(factory),
                _ => new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
                    issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app",
                    claims: [new Claim(JwtRegisteredClaimNames.Sub, box.MemberId.ToString()), new Claim("purpose", "qr_ident")],
                    expires: DateTime.UtcNow.AddMinutes(1),
                    signingCredentials: new SigningCredentials(
                        new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256))),
            };

            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(token)));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("not_recognised", body.GetProperty("error").GetString());
        }

        /// <summary>The court the member selected is the court booked, charged and lit — over the real wire.</summary>
        [SkippableFact]
        public async Task A_walk_up_over_signed_http_books_the_selected_court()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var client = factory.CreateClient();

            var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), court: 2)));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            using var check = factory.Services.CreateScope();
            var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var booking = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.UserId == box.MemberId);
            Assert.Equal(box.CourtIds[2], booking.CourtId);
            Assert.NotEqual(box.CourtIds[1], booking.CourtId);
            Assert.NotNull(booking.CheckedInAt);
        }

        /// <summary>
        /// The retry the firmware actually makes: the same signed body with the same nonce,
        /// after a lost response. The original grant comes back with <c>replayed: true</c> and
        /// the member is charged once (review H3).
        /// </summary>
        [SkippableFact]
        public async Task A_walk_up_retried_with_the_same_nonce_over_signed_http_is_replayed_not_resold()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();
            var code = await QrCodeAsync(factory, box);
            const string nonce = "0a1b2c3d4e5f6071";

            var first = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(code, nonce: nonce)));
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();

            var again = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(code, nonce: nonce)));
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);
            var againBody = await again.Content.ReadFromJsonAsync<JsonElement>();

            Assert.True(againBody.GetProperty("replayed").GetBoolean());
            Assert.Equal(firstBody.GetProperty("booking_id").GetGuid(), againBody.GetProperty("booking_id").GetGuid());
            Assert.Equal(30, againBody.GetProperty("granted_minutes").GetInt32());

            using var check = factory.Services.CreateScope();
            var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Single(await db.Bookings.IgnoreQueryFilters().Where(b => b.UserId == box.MemberId).ToListAsync());
            Assert.Single(await db.LedgerEntries.IgnoreQueryFilters()
                .Where(l => l.UserId == box.MemberId && l.Type == LedgerEntryType.LightsPurchase).ToListAsync());
        }

        [SkippableFact]
        public async Task A_walk_up_without_a_nonce_is_refused_over_signed_http()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();

            // The old three-field body, exactly as pre-C5 firmware would send it.
            var response = await client.SendAsync(FromBox(box, WalkUpPath, new { minutes = 30, method = "qr", token = await QrCodeAsync(factory, box) }));

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("nonce_required", body.GetProperty("error").GetString());
        }

        // ---- a booking code is not a wallet (closing re-review #19) ----------------------

        /// <summary>
        /// A booking-activation code names its member, and for a while that made it a
        /// spendable identity: anyone who read a roster code — pushed in clear to every box
        /// driving that court — could buy court time on that member's credits. A booking code
        /// opens its own booking on the activation paths and nothing else; a walk-up needs the
        /// member's ident code.
        /// </summary>
        [SkippableFact]
        public async Task A_booking_code_is_refused_as_a_walk_up_buyer()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 60);   // a live roster code for court 1
            var before = await BalanceAsync(factory, box.MemberId);

            var response = await factory.CreateClient().SendAsync(FromBox(box, WalkUpPath, WalkUp(booked.Code, minutes: 60, court: 2)));

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("not_recognised", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
            Assert.Equal(before, await BalanceAsync(factory, box.MemberId));
            Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.walk_up_created"));

            // ...while the same code still opens its own booking on the activation path.
            var activate = await factory.CreateClient().SendAsync(FromBox(box, ActivatePath, new { method = "qr", token = booked.Code }));
            Assert.Equal(HttpStatusCode.OK, activate.StatusCode);
            Assert.Equal("too_early", (await activate.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason").GetString());
        }

        /// <summary>Club B's booking code at club A's box: unknown there, whatever kind it is.</summary>
        [SkippableFact]
        public async Task Another_clubs_booking_code_is_refused_as_a_walk_up_buyer_here()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var boxA = await SeedAsync(factory);
            var boxB = await SeedAsync(factory);
            var bookedB = await BookAsync(factory, boxB, courtNumber: 1, startsInMinutes: 60);
            var before = await BalanceAsync(factory, boxB.MemberId);

            var response = await factory.CreateClient().SendAsync(FromBox(boxA, WalkUpPath, WalkUp(bookedB.Code)));

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("not_recognised", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
            Assert.Equal(before, await BalanceAsync(factory, boxB.MemberId));
        }

        /// <summary>
        /// The 17:00 purchase whose response was lost, rescanned at 17:40 with the same nonce:
        /// the box used to be told the ORIGINAL sixty minutes and drove the relay for an hour
        /// from 17:40, over whoever held the next slots. A replay grants what is left of the
        /// window; a window that has ended, or a purchase no longer Booked, is refused.
        /// </summary>
        [SkippableFact]
        public async Task A_replayed_walk_up_grants_the_remainder_and_is_refused_once_the_window_has_ended()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            // This test buys a full hour from the service's own UtcNow, and the club's day ends
            // at local midnight — so it needs the room SeedAsync's zone leaves in front of it
            // (RelayHardCap.Minutes plus an hour of slack). It used to ask for that separately,
            // which was the only place in this class that did.
            var box = await SeedAsync(factory);
            var client = factory.CreateClient();
            var nonce = Guid.NewGuid().ToString("N")[..16];
            var request = WalkUp(await QrCodeAsync(factory, box), minutes: 60, court: 1, nonce: nonce);

            var first = await client.SendAsync(FromBox(box, WalkUpPath, request));
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(60, firstBody.GetProperty("granted_minutes").GetInt32());
            var bookingId = firstBody.GetProperty("booking_id").GetGuid();

            // Forty minutes later.
            await ShiftWalkUpAsync(factory, bookingId, startsInMinutes: -40, endsInMinutes: 20);
            var mid = await client.SendAsync(FromBox(box, WalkUpPath, request));
            Assert.Equal(HttpStatusCode.OK, mid.StatusCode);
            var midBody = await mid.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(midBody.GetProperty("replayed").GetBoolean());
            Assert.InRange(midBody.GetProperty("granted_minutes").GetInt32(), 19, 20);

            // After the window.
            await ShiftWalkUpAsync(factory, bookingId, startsInMinutes: -70, endsInMinutes: -10);
            var over = await client.SendAsync(FromBox(box, WalkUpPath, request));
            Assert.Equal(HttpStatusCode.Conflict, over.StatusCode);
            Assert.Equal("purchase_ended", (await over.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

            // Promoted to Completed with time nominally left: still over as a purchase.
            await ShiftWalkUpAsync(factory, bookingId, startsInMinutes: -40, endsInMinutes: 20, status: BookingStatus.Completed);
            var completed = await client.SendAsync(FromBox(box, WalkUpPath, request));
            Assert.Equal(HttpStatusCode.Conflict, completed.StatusCode);
            Assert.Equal("purchase_ended", (await completed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

            // Charged exactly once throughout.
            Assert.Single(await LedgerAsync(factory, bookingId));
            Assert.Equal(200 - 60, await BalanceAsync(factory, box.MemberId));
        }

        // ---- lighting a booked court from the box -------------------------------

        /// <summary>
        /// The pre-booked member's path (review C3), over the real wire: a booking-activation
        /// code on the signed device group answers the seconds the box puts on its relay timer.
        /// </summary>
        [SkippableFact]
        public async Task Activate_over_authenticated_http()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);

            Guid bookingId;
            string code;
            using (var scope = factory.Services.CreateScope())
            {
                scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var startsAt = DateTimeOffset.UtcNow.AddMinutes(1);
                var booking = new Booking
                {
                    TenantId = box.TenantId,
                    CourtId = box.CourtIds[2],
                    UserId = box.MemberId,
                    BookedByUserId = box.MemberId,
                    PaidByUserId = box.MemberId,
                    ActorUserId = box.MemberId,
                    StartsAt = startsAt,
                    EndsAt = startsAt.AddMinutes(45),
                    SliceMinutes = 15,
                    SliceCount = 3,
                    AmountChargedMinutes = 45,
                    Status = BookingStatus.Booked,
                    ChargedAt = DateTimeOffset.UtcNow,
                };
                db.Bookings.Add(booking);
                await db.SaveChangesAsync();
                bookingId = booking.Id;
                code = (await scope.ServiceProvider.GetRequiredService<AccessCodeService>()
                    .MintForBookingAsync(booking, TimeSpan.FromMinutes(5), default)).Code;
            }

            var client = factory.CreateClient();
            var response = await client.SendAsync(FromBox(box, ActivatePath, new { method = "qr", token = code }));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(body.GetProperty("activated").GetBoolean());
            Assert.Equal("ok", body.GetProperty("reason").GetString());
            Assert.Equal(2, body.GetProperty("court_number").GetInt32());
            Assert.Equal(bookingId, body.GetProperty("booking_id").GetGuid());
            Assert.InRange(body.GetProperty("granted_seconds").GetInt32(), 45 * 60, 46 * 60 + 1);
            Assert.False(body.TryGetProperty("starts_in_seconds", out _));
            // server_unix went with the clock the device scheme no longer keeps.
            Assert.False(body.TryGetProperty("server_unix", out _));

            using var check = factory.Services.CreateScope();
            var db2 = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.NotNull((await db2.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId)).CheckedInAt);
        }

        [SkippableFact]
        public async Task An_unauthenticated_activation_is_refused()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            await SeedAsync(factory);
            var client = factory.CreateClient();

            var response = await client.PostAsJsonAsync(ActivatePath, new { method = "qr", token = "7Q3F9KM2XZ8B" });
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }

        /// <summary>
        /// The heartbeat carries the roster over the real wire, in the four-field shape the
        /// firmware parses, with the relay from the box's own court list and the seconds
        /// relative to the response. The booking was written with no code; the heartbeat mints
        /// it, and the token on the wire is the code the member's phone will show.
        /// </summary>
        [SkippableFact]
        public async Task Heartbeat_carries_the_roster_over_signed_http()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var beforeBooking = DateTimeOffset.UtcNow;
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 5, minutes: 45, mintCode: false);

            var body = await HeartbeatAsync(factory, box);

            // The seconds are relative to the RESPONSE, so they drift by however long the booking
            // and the heartbeat took between them. A fixed five-second allowance went red at -308
            // on a machine under load 20 while the same test passed alone: the tolerance is the
            // measured time from before the booking's clock read to after the response, plus one
            // for the rounding of whole seconds.
            var slack = 1 + (long)Math.Ceiling((DateTimeOffset.UtcNow - beforeBooking).TotalSeconds);

            var roster = body.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();
            var entry = Assert.Single(roster);
            Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry);

            var fields = entry.Split('|');
            Assert.Equal(1, int.Parse(fields[1]));                                       // court 2 is relay B on this box
            Assert.InRange(long.Parse(fields[2]), (5 - 10) * 60 - slack, (5 - 10) * 60);  // cue of 10 opened five minutes ago
            Assert.InRange(long.Parse(fields[3]), 50 * 60 - slack, 50 * 60);             // ends in fifty

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var code = await db.AccessCodes.IgnoreQueryFilters().SingleAsync(c => c.BookingId == booked.BookingId);
            Assert.Equal(code.Code, fields[0]);
            Assert.Equal(AccessCodePurpose.BookingActivation, code.Purpose);
        }

        /// <summary>
        /// Seventeen bookings in the window: sixteen go, and the whole response still fits the
        /// box's buffer. The cap is what bounds the response, so this is where the byte budget
        /// is held against the live serializer rather than a hand-written vector.
        /// </summary>
        [SkippableFact]
        public async Task Heartbeat_roster_is_capped_at_sixteen_and_the_response_fits_the_boxs_buffer()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            // The literal, not the constant: this is the contract number the firmware buffer is
            // sized to (bridgelogic::kMaxRosterEntries), and a test that reads the cap off the
            // builder would follow the builder if somebody raised it.
            const int contractCap = 16;

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2, 3, 4]);
            for (var i = 0; i < contractCap + 2; i++)
            {
                await BookAsync(factory, box, courtNumber: 1 + (i % 4), startsInMinutes: 1 + i * 5, minutes: 5);
            }

            var response = await factory.CreateClient().SendAsync(FromBox(box, HeartbeatPath, new { running_version = "1.0.0" }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var bytes = await response.Content.ReadAsByteArrayAsync();
            Assert.True(bytes.Length <= 2048, $"heartbeat response is {bytes.Length} bytes; the box holds 2048");

            var roster = JsonDocument.Parse(bytes).RootElement.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();
            Assert.Equal(contractCap, roster.Count);
            Assert.All(roster, e => Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, e));
            Assert.DoesNotContain(roster, e => e.Contains('\\'));   // the serializer must not escape the separator
        }

        // ---- the per-box button map on the wire (closing re-review #17) -------------------

        /// <summary>The heartbeat carries the map THIS box runs: its own override when it has one, else the club's.</summary>
        [SkippableFact]
        public async Task Heartbeat_carries_the_boxs_own_button_map_when_it_has_one()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var box = await SeedAsync(factory);

            var clubMap = (await HeartbeatAsync(factory, box)).GetProperty("config").GetProperty("button_map").EnumerateArray().Select(e => e.GetString()).ToList();
            Assert.Equal(["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"], clubMap);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == box.DeviceId);
                Assert.True(ButtonMap.TryParse(["court:A", "off", "none", "none", "minutes:15", "minutes:30", "none", "none"], out var own, out _));
                row.ButtonMapJson = own!.ToJson();
                await db.SaveChangesAsync();
            }

            var ownMap = (await HeartbeatAsync(factory, box)).GetProperty("config").GetProperty("button_map").EnumerateArray().Select(e => e.GetString()).ToList();
            Assert.Equal(["court:A", "off", "none", "none", "minutes:15", "minutes:30", "none", "none"], ownMap);
        }
    }
}
