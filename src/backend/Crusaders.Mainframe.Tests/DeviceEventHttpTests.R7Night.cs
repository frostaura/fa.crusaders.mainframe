using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.DependencyInjection;

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
