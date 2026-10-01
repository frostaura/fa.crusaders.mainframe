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
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

public abstract partial class AdminSettingsHttpTests
{
    /// <summary>The club's timezone, its peak window and its per-weekday opening hours.</summary>
    public sealed class TimeAndHours(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// The timezone is writable, and it is the zone the schedule actually renders in.
        ///
        /// <para>
        /// It was served by GET and had no member on <c>UpdateSettingsRequest</c>, so the PUT
        /// could not carry one: a second club in another zone saw its whole booking grid in
        /// South African wall-clock time, with no correction short of an UPDATE on the
        /// <c>tenant_settings</c> JSON column. "Multi-tenancy is structural from day one" and a
        /// tenant-scoped setting that only the database can change are not compatible.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task The_timezone_is_writable_and_reaches_the_engine()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"timezone":"Africa/Johannesburg"}""");
            var client = AdminClient(factory, seeded);

            var save = await client.PutAsJsonAsync(SettingsPath, BaseSettings(tz: "Europe/London"));
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            var read = await (await client.GetAsync(SettingsPath)).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("Europe/London", read.GetProperty("timezone").GetString());

            using var scope = factory.Services.CreateScope();
            var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
            tenantContext.Set(seeded.TenantId, seeded.Slug);
            Assert.Equal("Europe/London", (await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default)).Timezone);
        }

        [SkippableTheory]
        [InlineData("Mars/Olympus_Mons")]
        [InlineData("")]
        [InlineData("   ")]
        public async Task A_timezone_the_tzdb_does_not_know_is_refused(string tz)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"timezone":"Africa/Johannesburg"}""");
            var client = AdminClient(factory, seeded);

            var save = await client.PutAsJsonAsync(SettingsPath, BaseSettings(tz: tz));
            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            Assert.Equal("timezone_invalid", (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

            // And nothing was written: a refused save must not half-apply.
            var read = await (await client.GetAsync(SettingsPath)).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("Africa/Johannesburg", read.GetProperty("timezone").GetString());
        }

        [SkippableTheory]
        [InlineData("19:00-16:00")]
        [InlineData("16:00")]
        [InlineData("not a time-range")]
        public async Task A_malformed_peak_window_is_refused(string range)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            // TenantSettingsAccessor.PeakHours() returns null on a malformed range and the
            // booking rule then silently stops applying — league exclusivity would just
            // quietly not happen, which nobody would notice until a member complained.
            var save = await client.PutAsJsonAsync(SettingsPath, new
            {
                sliceMinutes = 15,
                slicePriceCredits = 8,
                advanceBookingDays = 14,
                dayStartMinute = 360,
                dayEndMinute = 1320,
                penaltyPct = 30m,
                graceWindowMinutes = 5,
                penaltyWindowMinutes = 15,
                peakHours = range,
            });

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
        }

        // ---- the per-weekday opening hours (R2 G-F2) ---------------------------------
        //
        // A club could not change its opening hours at all. The engine reads
        // `operating_hours`, a per-weekday map; this endpoint served only the flat
        // `day_start_minute`/`day_end_minute` pair and had no member for the map, and the
        // seeder names all seven days — so the flat pair was dead for every day of the week.
        // An admin setting "Day starts 09:00" got `200 {"saved":true}` and a success toast,
        // and Monday's grid still ran 06:00-21:45. The setting the product ENFORCES could not
        // be edited by the product.

        [SkippableFact]
        public async Task The_settings_response_carries_the_per_weekday_hours_the_engine_reads()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00","mon":"06:00-22:00"}}""");
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            var hours = shown.GetProperty("operating_hours");

            Assert.Equal("06:00-22:00", hours.GetProperty("mon").GetString());
            Assert.Equal("07:00-20:00", hours.GetProperty("sat").GetString());
            // A day the club has not named is absent rather than invented: it follows the flat
            // pair, and showing it as 06:00-22:00 would make the screen claim a Sunday setting
            // that does not exist.
            Assert.False(hours.TryGetProperty("sun", out _));
        }

        /// <summary>
        /// The whole point of the finding: what the settings screen writes has to be what
        /// <see cref="BookingService"/> reads. Asserted through
        /// <see cref="TenantSettingsView.HoursFor"/>, which is the exact call the booking rule
        /// makes — <c>CheckOperatingHoursRule</c> does nothing else.
        /// </summary>
        [SkippableFact]
        public async Task Saving_the_weekday_hours_changes_what_the_booking_rule_enforces()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
            var client = AdminClient(factory, seeded);

            var before = await EngineAsync(factory, seeded);
            Assert.Equal((7 * 60, 20 * 60), before.HoursFor(DayOfWeek.Saturday));

            var body = Baseline();
            body["operatingHours"] = new Dictionary<string, string>
            {
                ["sat"] = "08:00-13:00",
                ["sun"] = "09:00-12:00",
            };
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            var after = await EngineAsync(factory, seeded);
            Assert.Equal((8 * 60, 13 * 60), after.HoursFor(DayOfWeek.Saturday));
            Assert.Equal((9 * 60, 12 * 60), after.HoursFor(DayOfWeek.Sunday));
            // A weekday the new map does not name falls back to the flat pair, which is what
            // makes "Day starts / Day ends" an honest default rather than a dead field.
            Assert.Equal((360, 1320), after.HoursFor(DayOfWeek.Monday));

            // And the screen reads back exactly what it wrote.
            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal("08:00-13:00", shown.GetProperty("operating_hours").GetProperty("sat").GetString());
        }

        [SkippableFact]
        public async Task An_empty_weekday_map_puts_every_day_back_on_the_flat_pair()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["operatingHours"] = new Dictionary<string, string>();
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            var after = await EngineAsync(factory, seeded);
            Assert.True(after.OperatingHours.IsEmpty);
            Assert.Equal((360, 1320), after.HoursFor(DayOfWeek.Saturday));
        }

        [SkippableFact]
        public async Task A_weekday_map_survives_a_save_that_does_not_mention_it()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
            var client = AdminClient(factory, seeded);

            // The devices screen saving a button map, for instance: omitted means unchanged,
            // never "reset to default".
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, Baseline())).StatusCode);

            var after = await EngineAsync(factory, seeded);
            Assert.Equal((7 * 60, 20 * 60), after.HoursFor(DayOfWeek.Saturday));
        }

        [SkippableTheory]
        [InlineData("sat", "20:00-07:00")]   // close before open is a typo, not an overnight club
        [InlineData("sat", "not a range")]
        [InlineData("sat", "07:00")]
        [InlineData("caturday", "07:00-20:00")]
        public async Task A_weekday_map_that_cannot_be_read_is_refused_with_the_day_named(string day, string range)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["operatingHours"] = new Dictionary<string, string> { [day] = range };
            var refused = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            var payload = await refused.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("operating_hours_day_invalid", payload.GetProperty("error").GetString());
            // Which row to fix. "operating hours invalid" on a seven-row form is not an answer.
            Assert.Equal(day.ToLowerInvariant(), payload.GetProperty("day").GetString());

            // And the refusal is whole: nothing was half-written.
            var after = await EngineAsync(factory, seeded);
            Assert.Equal((7 * 60, 20 * 60), after.HoursFor(DayOfWeek.Saturday));
        }
    }
}
