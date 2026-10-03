using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

public abstract partial class DeviceEventHttpTests
{
    /// <summary>
    /// Review round 7, E7-1: what a member's night says about uploaded relay evidence. A refused
    /// upload invented a lit court and counted its minutes; an accepted one showed twice.
    /// </summary>
    public sealed class R7Night(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        [SkippableFact]
        public async Task A_refused_upload_lights_nothing_and_an_accepted_one_is_told_once_at_the_scan()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -2);

            // Relay 0 is court 1: refused, wrong court. Relay 1 is court 2: the member's own court.
            // Both scans are uploaded later (batch uptime 600 s; the scans at 200 s and 300 s).
            var upload = await factory.CreateClient().SendAsync(FromBox(box, EventsPath, Batch(
                Activation(1, subject: booked.Code, court: 0, uptimeMs: 200_000),
                Activation(2, subject: booked.Code, court: 1, uptimeMs: 300_000))));
            upload.EnsureSuccessStatusCode();
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_wrong_court"));
            Assert.NotNull((await BookingAsync(factory, booked.BookingId)).CheckedInAt);

            var night = await NightAsync(factory, box);
            var lights = night.GetProperty("events").EnumerateArray()
                .Where(e => e.GetProperty("kind").GetString() == TraceKinds.LightsOn).ToList();

            // One lighting, told once — at the scan, by the box — and never the refused relay.
            var on = Assert.Single(lights);
            Assert.Equal(TraceActors.Device, on.GetProperty("actor").GetProperty("kind").GetString());
            var scan = DateTimeOffset.UtcNow.AddMilliseconds(-300_000);
            Assert.InRange(on.GetProperty("at").GetDateTimeOffset(), scan.AddSeconds(-60), scan.AddSeconds(60));

            // A refused relay is not time on court: one accepted receipt measures nothing yet.
            Assert.Equal(0, night.GetProperty("summary").GetProperty("minutes_on_court").GetInt32());
        }

        /// <summary>
        /// Review round 8, D8-4. A release names no session, so it is paired with the last
        /// activation receipt on its relay — and a REFUSED receipt (a relay wired to another court:
        /// the legacy path keeps its booking on the row) is no lighting of that booking. Paired, it
        /// settled the member's court from a relay this box never lit for them, and the night said
        /// the lights went off with no lighting before it.
        /// </summary>
        [SkippableFact]
        public async Task A_release_never_pairs_with_a_refused_activation_receipt()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -2);
            var client = factory.CreateClient();

            // Relay 0 is court 1: the activation is refused as wrong_court. Five minutes later the
            // relay opens — the release reconciles with that receipt to the second.
            (await client.SendAsync(FromBox(box, EventsPath, Batch(
                Activation(1, subject: booked.Code, court: 0, uptimeMs: 200_000))))).EnsureSuccessStatusCode();
            Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_wrong_court"));
            (await client.SendAsync(FromBox(box, EventsPath, Batch(
                Release(2, court: 0, heldMs: 300_000, uptimeMs: 500_000))))).EnsureSuccessStatusCode();

            Assert.Single(await AuditAsync(factory, box.TenantId, "device.release_unpaired"));
            var night = await NightAsync(factory, box);
            Assert.DoesNotContain(night.GetProperty("events").EnumerateArray(),
                e => e.GetProperty("kind").GetString() == TraceKinds.LightsOff);
        }

        /// <summary>
        /// Review round 8, E8-1 (asked of this file by lane BE). A late box upload that reverses a
        /// no-show stamped the booking and no seat: the page read "Checked in" above "0 of 2 players
        /// checked in", and the scanner's night had no "Checked in" row. The upload now hands the
        /// reversal who scanned, so the scanner's own accepted seat is stamped and the
        /// <c>court.activated</c> row names them.
        /// </summary>
        [SkippableFact]
        public async Task A_late_upload_that_reverses_a_no_show_checks_in_the_player_who_scanned()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);
            var partner = await AnotherMemberAsync(factory, box);
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                foreach (var (seat, user) in new[] { (1, box.MemberId), (2, partner) })
                {
                    db.BookingParticipants.Add(new BookingParticipant
                    {
                        TenantId = box.TenantId, BookingId = booked.BookingId, Seat = seat, UserId = user,
                        Status = ParticipantStatus.Accepted, InvitedAt = DateTimeOffset.UtcNow,
                        CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
                    });
                }
                await db.SaveChangesAsync();
            }

            // The organiser's queued scan, uploaded after the sweep.
            (await factory.CreateClient().SendAsync(FromBox(box, EventsPath, Batch(
                Activation(1, subject: booked.Code, court: 0))))).EnsureSuccessStatusCode();
            Assert.NotNull((await BookingAsync(factory, booked.BookingId)).CheckedInAt);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var seats = await db.BookingParticipants.IgnoreQueryFilters()
                    .Where(p => p.BookingId == booked.BookingId).OrderBy(p => p.Seat).ToListAsync();
                Assert.NotNull(seats[0].CheckedInAt);     // the organiser, who scanned
                Assert.Null(seats[1].CheckedInAt);        // the partner, who did not
            }
            var activated = Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
            Assert.Equal(box.MemberId, activated.ActorUserId);
            using var details = JsonDocument.Parse(activated.DetailsJson!);
            Assert.True(details.RootElement.GetProperty("reversed_no_show").GetBoolean());
        }

        /// <summary>Keeps every event the server emits and still hands them on.</summary>
        private sealed class KeepingBus : IEventBus
        {
            private readonly System.Threading.Channels.Channel<DomainEvent> _channel =
                System.Threading.Channels.Channel.CreateUnbounded<DomainEvent>();
            private readonly List<DomainEvent> _kept = [];

            public System.Threading.Channels.ChannelReader<DomainEvent> Reader => _channel.Reader;

            public List<DomainEvent> Kept
            {
                get { lock (_kept) return [.. _kept]; }
            }

            public async ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default)
            {
                lock (_kept) _kept.Add(evt);
                await _channel.Writer.WriteAsync(evt, ct);
            }
        }

        /// <summary>
        /// Review round 11, E11-3. A late upload that reversed a settled no-show: the Night's lights
        /// row was the board's receipt and said only "reported by the court's board" though its
        /// server twin recorded whose code was read; <c>booking.no_show_reversed</c> had no actor;
        /// and no <c>booking.lights_on</c> went out at all, though the webhooks contract lists the
        /// roster fallback uploaded later. All three name the scanner now.
        /// </summary>
        [SkippableFact]
        public async Task A_late_upload_that_reverses_a_no_show_names_the_scanner_everywhere()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var box = await SeedAsync(factory);
            var (booked, _) = await SweptNoShowAsync(factory, box);

            var bus = new KeepingBus();
            await using var app = factory.WithWebHostBuilder(b => b.ConfigureServices(sv =>
            {
                sv.RemoveAll<IEventBus>();
                sv.AddSingleton<IEventBus>(bus);
                sv.RemoveAll<Crusaders.Mainframe.Api.Email.IEmailService>();
                sv.AddSingleton<Crusaders.Mainframe.Api.Email.IEmailService>(new StubEmailService());
            }));
            (await app.CreateClient().SendAsync(FromBox(box, EventsPath, Batch(
                Activation(1, subject: booked.Code, court: 0))))).EnsureSuccessStatusCode();
            Assert.Equal(BookingStatus.Booked, (await BookingAsync(factory, booked.BookingId)).Status);

            var reversed = Assert.Single(bus.Kept, e => e.Type == "booking.no_show_reversed");
            Assert.Equal(box.MemberId, reversed.ActorUserId);
            Assert.Equal(box.MemberId, (Guid?)reversed.Data["identified_user_id"]);

            var lit = Assert.Single(bus.Kept, e => e.Type == "booking.lights_on");
            Assert.Equal(box.MemberId, lit.ActorUserId);
            Assert.Equal(booked.BookingId, (Guid)lit.Data["booking_id"]!);
            Assert.Equal(box.MemberId, (Guid)lit.Data["identified_user_id"]!);

            var night = await NightAsync(factory, box);
            var on = Assert.Single(night.GetProperty("events").EnumerateArray(),
                e => e.GetProperty("kind").GetString() == TraceKinds.LightsOn);
            Assert.Equal(TraceActors.Device, on.GetProperty("actor").GetProperty("kind").GetString());
            Assert.Equal(box.MemberId, on.GetProperty("code_holder").GetProperty("user_id").GetGuid());
        }

        /// <summary>The admin's view of the box member's night, through the real route.</summary>
        private static async Task<JsonElement> NightAsync(TestWebAppFactory factory, Box box)
        {
            var adminId = Guid.NewGuid();
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.Users.Add(new User
                {
                    Id = adminId, TenantId = box.TenantId, Email = $"adm-{box.Slug}@test.local", PasswordHash = "x",
                    EmailVerified = true, IsAdmin = true,
                });
                await db.SaveChangesAsync();
            }

            var club = new DoorClub(box.TenantId, box.Slug, box.ApiKey, adminId, box.MemberId, box.CourtId);
            var client = factory.CreateClient();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", club.TokenFor(adminId, "admin"));
            return await client.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{box.MemberId}/trace");
        }
    }
}
