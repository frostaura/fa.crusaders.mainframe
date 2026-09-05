using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// F1 — every way a booking can be refused, over real HTTP, with the code the member's
/// phone actually receives.
///
/// <para>
/// The endpoint's <c>result switch</c> named seven of the service's ten outcomes and ended
/// in <c>_ =&gt; Results.Problem("Unexpected")</c>. The two headline rules of the whole
/// booking model — peak-hour league exclusivity (A.12) and the per-member-per-day cap
/// (A.4/B.3) — fell into that default, so a member who hit either was answered HTTP 500
/// and shown "Booking failed.". The service had already built the exact sentence, with the
/// peak window and the member's own minutes in it, and the endpoint discarded it. Nothing
/// appeared in the log either, because <c>Results.Problem</c> is a return and not a throw:
/// an operator watching <c>api.log</c> saw no evidence that a rule had ever refused anyone.
/// </para>
///
/// <para>
/// Postgres-backed rather than in-memory on purpose. These are the refusals that decide
/// whether money moves, and the in-memory provider has no transaction, no exclusion
/// constraint and no numeric column — a refusal test written against it can pass while
/// demonstrating the failure it was meant to catch (see <c>memory/gotchas.md</c>).
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class BookingRefusalHttpTests
{
    private readonly PostgresFixture _pg;

    public BookingRefusalHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string BookingsPath = "/api/v1/bookings/";

    /// <summary>Slice price in the fixture below; a whole number so a wrong figure is obvious in a failure message.</summary>
    private const decimal SlicePriceCredits = 50m;

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId, Guid LeagueUserId, Guid CourtId, Guid SecondCourtId);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>
    /// Finder B's own club, verbatim: 15-minute slices at 50 credits, peak 16:00–19:00 with
    /// one hour of advance for Regulars, a 60-minute daily cap, and hours 06:00–22:00 every
    /// day so this file's assertions are about the rule under test and not about the clock.
    /// </summary>
    private const string SettingsJson = """
        {"slice_minutes":15,"slice_price_credits":50,"penalty_pct":30,"grace_window_minutes":5,
         "penalty_window_minutes":15,"advance_booking_days":14,"timezone":"UTC",
         "member_per_day_max_minutes":60,"peak_hours":"16:00-19:00","peak_advance_hours_for_regular":1,
         "day_start_minute":0,"day_end_minute":1440}
        """;

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"bk-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Refusal Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = SettingsJson });

        var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"member-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        var league = new User { TenantId = tenant.Id, Email = $"league-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member, league);
        db.Memberships.AddRange(
            new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Refusal Admin", MembershipNumber = $"{slug}-A", Status = MembershipStatus.Active, MemberClass = MemberClass.Regular },
            new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Naledi Khoza", MembershipNumber = $"{slug}-M", Status = MembershipStatus.Active, MemberClass = MemberClass.Regular },
            new Membership { TenantId = tenant.Id, UserId = league.Id, FullName = "Liam O'Connor", MembershipNumber = $"{slug}-L", Status = MembershipStatus.Active, MemberClass = MemberClass.LeagueOrSenior });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = SlicePriceCredits };
        var court2 = new Court { TenantId = tenant.Id, CourtNumber = 2, Name = "Court 2", SlicePriceCredits = SlicePriceCredits };
        db.Courts.AddRange(court, court2);

        // Plenty of credit, so an insufficient-balance answer can never be mistaken for a
        // rule refusal — the two are the pair this file exists to keep apart.
        foreach (var u in new[] { member, league })
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant.Id,
                UserId = u.Id,
                ActorUserId = admin.Id,
                Type = LedgerEntryType.AdminAdjustment,
                AmountCredits = 5000m,
                Reason = "Seed float",
            });
        }

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id, member.Id, league.Id, court.Id, court2.Id);
    }

    private static string TokenFor(Seeded s, Guid userId, bool isAdmin)
    {
        List<Claim> claims =
        [
            new Claim(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new Claim("tenant_id", s.TenantId.ToString()),
            new Claim("tenant_slug", s.Slug),
            new Claim("purpose", "access"),
        ];
        if (isAdmin) claims.Add(new Claim(ClaimTypes.Role, "admin"));

        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static HttpClient ClientFor(TestWebAppFactory factory, Seeded s, Guid userId, bool isAdmin = false)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TokenFor(s, userId, isAdmin));
        return client;
    }

    /// <summary>The next occurrence of a given UTC hour that is at least a day away — deterministic against the peak and advance rules whatever time the suite runs.</summary>
    private static DateTimeOffset NextDayAt(int hour, int minute = 0)
    {
        var d = DateTime.UtcNow.Date.AddDays(2);
        return new DateTimeOffset(d.Year, d.Month, d.Day, hour, minute, 0, TimeSpan.Zero);
    }

    private static async Task<(HttpStatusCode Status, JsonElement Body)> PostBookingAsync(
        HttpClient client, Guid courtId, DateTimeOffset startsAt, int sliceCount = 1)
    {
        var res = await client.PostAsJsonAsync(BookingsPath, new { courtId, startsAt, sliceCount });
        var text = await res.Content.ReadAsStringAsync();
        using var doc = string.IsNullOrWhiteSpace(text) ? JsonDocument.Parse("{}") : JsonDocument.Parse(text);
        return (res.StatusCode, doc.RootElement.Clone());
    }

    // ---- The two rules that answered 500 ----

    [SkippableFact]
    public async Task A_regular_member_refused_a_peak_slot_is_told_which_rule_stopped_them()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var member = ClientFor(factory, s, s.MemberUserId);

        // 17:00, two days out — squarely inside 16:00–19:00 and far outside the one hour of
        // advance a Regular gets. This exact request answered 500 with an exception dump.
        var (status, body) = await PostBookingAsync(member, s.CourtId, NextDayAt(17));

        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("peak_hours_league_only", body.GetProperty("error").GetString());
        // The figures the sentence is built from, so the copy names the real window rather
        // than repeating a constant the client would have to keep in step by hand.
        Assert.Equal("16:00", body.GetProperty("peak_start").GetString());
        Assert.Equal("19:00", body.GetProperty("peak_end").GetString());
        Assert.Equal(1, body.GetProperty("regular_advance_hours").GetInt32());
    }

    [SkippableFact]
    public async Task A_league_member_is_still_let_through_the_same_peak_slot()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var league = ClientFor(factory, s, s.LeagueUserId);

        // The rule has to DISCRIMINATE, not merely refuse: a mapping fix that turned every
        // peak booking into a 409 would satisfy the test above and break the product.
        var (status, _) = await PostBookingAsync(league, s.CourtId, NextDayAt(17));
        Assert.Equal(HttpStatusCode.OK, status);
    }

    [SkippableFact]
    public async Task A_member_at_their_daily_cap_is_told_the_cap_and_their_own_minutes()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var member = ClientFor(factory, s, s.MemberUserId);

        // Four 15-minute slices = the full 60 permitted minutes, all outside peak.
        for (var i = 0; i < 4; i++)
        {
            var (ok, _) = await PostBookingAsync(member, s.CourtId, NextDayAt(9, i * 15));
            Assert.Equal(HttpStatusCode.OK, ok);
        }

        var (status, body) = await PostBookingAsync(member, s.CourtId, NextDayAt(10));

        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("per_day_cap_exceeded", body.GetProperty("error").GetString());
        Assert.Equal(60, body.GetProperty("cap_minutes").GetInt32());
        Assert.Equal(60, body.GetProperty("already_booked_minutes").GetInt32());
        Assert.Equal(15, body.GetProperty("attempted_minutes").GetInt32());
    }

    [SkippableFact]
    public async Task A_booking_the_club_is_shut_for_is_refused_with_the_hours_that_day()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        // Narrow this club's hours after seeding so the rest of the file stays clock-free.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(x => x.TenantId == s.TenantId);
            row.SettingsJson = SettingsJson.Replace("\"day_end_minute\":1440", "\"day_end_minute\":1200");
            await db.SaveChangesAsync();
        }

        var member = ClientFor(factory, s, s.MemberUserId);
        var (status, body) = await PostBookingAsync(member, s.CourtId, NextDayAt(21, 45));

        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("out_of_hours", body.GetProperty("error").GetString());
        Assert.Equal("20:00", body.GetProperty("closes_at").GetString());
    }

    /// <summary>
    /// The property the whole finding turns on: NO refusal on this endpoint is a 500 any
    /// more. A future result type added to the service without an arm here still answers
    /// 500 — but it now logs, and this test is the trigger that would find it.
    /// </summary>
    [SkippableTheory]
    [InlineData(17, 0, 1, "peak_hours_league_only")]
    [InlineData(9, 0, 0, "invalid_duration")]
    [InlineData(9, 0, 200, "invalid_duration")]
    public async Task No_booking_refusal_answers_a_server_error(int hour, int minute, int sliceCount, string expectedError)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var member = ClientFor(factory, s, s.MemberUserId);

        var (status, body) = await PostBookingAsync(member, s.CourtId, NextDayAt(hour, minute), sliceCount);

        Assert.True((int)status < 500, $"a refusal answered {(int)status}; the member is shown a generic failure and the log says nothing");
        Assert.Equal(expectedError, body.GetProperty("error").GetString());
    }

    // ---- F4 / F5 / F8: the member is told what cancelling costs, before they tap ----

    private static async Task<JsonElement> QuoteAsync(HttpClient client, Guid bookingId)
    {
        var res = await client.GetAsync($"{BookingsPath}{bookingId}/cancellation-quote");
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    private static async Task<Guid> BookAsync(HttpClient client, Guid courtId, DateTimeOffset startsAt)
    {
        var (status, body) = await PostBookingAsync(client, courtId, startsAt);
        Assert.Equal(HttpStatusCode.OK, status);
        return body.GetProperty("booking_id").GetGuid();
    }

    [SkippableFact]
    public async Task Outside_the_penalty_window_the_quote_says_the_whole_price_comes_back()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var member = ClientFor(factory, s, s.MemberUserId);
        var bookingId = await BookAsync(member, s.CourtId, NextDayAt(9));

        var quote = await QuoteAsync(member, bookingId);

        Assert.False(quote.GetProperty("insidePenaltyWindow").GetBoolean());
        Assert.False(quote.GetProperty("checkedIn").GetBoolean());
        Assert.Equal(SlicePriceCredits, quote.GetProperty("refundCredits").GetDecimal());
        Assert.Equal(0m, quote.GetProperty("penaltyCredits").GetDecimal());
    }

    [SkippableFact]
    public async Task Inside_the_penalty_window_the_quote_states_the_penalty_and_the_net_refund()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var member = ClientFor(factory, s, s.MemberUserId);
        var bookingId = await BookAsync(member, s.CourtId, NextDayAt(9));

        // Pull the slot start inside the 15-minute window. Moving the booking rather than
        // waiting is what keeps this a test and not a fifteen-minute pause.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var b = await db.Bookings.IgnoreQueryFilters().FirstAsync(x => x.Id == bookingId);
            b.StartsAt = DateTimeOffset.UtcNow.AddMinutes(5);
            b.EndsAt = b.StartsAt.AddMinutes(15);
            await db.SaveChangesAsync();
        }

        var quote = await QuoteAsync(member, bookingId);

        Assert.True(quote.GetProperty("insidePenaltyWindow").GetBoolean());
        // 30% of 50.00 is kept; 35.00 is what actually lands back in the wallet. The
        // member was shown neither figure before this existed — the confirmation was a
        // button that changed its own label.
        Assert.Equal(15m, quote.GetProperty("penaltyCredits").GetDecimal());
        Assert.Equal(35m, quote.GetProperty("refundCredits").GetDecimal());
        Assert.Equal(30m, quote.GetProperty("penaltyPct").GetDecimal());
    }

    [SkippableFact]
    public async Task Once_the_lights_have_been_on_the_quote_says_nothing_comes_back()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var member = ClientFor(factory, s, s.MemberUserId);
        var bookingId = await BookAsync(member, s.CourtId, NextDayAt(9));

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var b = await db.Bookings.IgnoreQueryFilters().FirstAsync(x => x.Id == bookingId);
            b.CheckedInAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }

        var quote = await QuoteAsync(member, bookingId);

        // settlement-model.md S4. This is the case that mattered most and disclosed least:
        // the member scanned in at the box, cancelled from the sofa, lost the entire price
        // and was told "Booking cancelled — refund pending."
        Assert.True(quote.GetProperty("checkedIn").GetBoolean());
        Assert.Equal(0m, quote.GetProperty("refundCredits").GetDecimal());
        Assert.Equal(0m, quote.GetProperty("penaltyCredits").GetDecimal());
        Assert.Equal(SlicePriceCredits, quote.GetProperty("amountChargedCredits").GetDecimal());
    }

    [SkippableFact]
    public async Task A_stranger_cannot_read_what_someone_elses_booking_cost()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var bookingId = await BookAsync(ClientFor(factory, s, s.MemberUserId), s.CourtId, NextDayAt(9));

        // Booking ids are readable straight off GET /api/v1/schedule, so a quote endpoint
        // that answered anyone would hand every member's spend to every other member.
        // 404, not 403 — a distinct refusal would confirm the id is real.
        var res = await ClientFor(factory, s, s.LeagueUserId).GetAsync($"{BookingsPath}{bookingId}/cancellation-quote");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [SkippableFact]
    public async Task The_schedule_tells_the_owner_and_the_admin_that_a_slot_is_checked_in()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var startsAt = NextDayAt(9);
        var bookingId = await BookAsync(ClientFor(factory, s, s.MemberUserId), s.CourtId, startsAt);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var b = await db.Bookings.IgnoreQueryFilters().FirstAsync(x => x.Id == bookingId);
            b.CheckedInAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }

        var date = startsAt.UtcDateTime.ToString("yyyy-MM-dd");

        // The owner sees it — the projection did not carry CheckedInAt at all, so no screen
        // in the product could have shown attendance even if it wanted to.
        var mine = await Slot(ClientFor(factory, s, s.MemberUserId));
        Assert.True(mine.GetProperty("checkedIn").GetBoolean());
        Assert.Equal(SlicePriceCredits, mine.GetProperty("amountChargedCredits").GetDecimal());

        // The admin sees it.
        Assert.True((await Slot(ClientFor(factory, s, s.AdminUserId, isAdmin: true))).GetProperty("checkedIn").GetBoolean());

        // Another member sees neither — "the booking grid shows photo + name only", and
        // another member's attendance and spend are no more theirs to read than an email.
        var theirs = await Slot(ClientFor(factory, s, s.LeagueUserId));
        Assert.Equal(JsonValueKind.Null, theirs.GetProperty("checkedIn").ValueKind);
        Assert.Equal(JsonValueKind.Null, theirs.GetProperty("amountChargedCredits").ValueKind);

        async Task<JsonElement> Slot(HttpClient client)
        {
            var day = await client.GetFromJsonAsync<JsonElement>($"/api/v1/schedule?date={date}");
            return day.GetProperty("slots").EnumerateArray()
                .Single(x => x.GetProperty("bookingId").GetGuid() == bookingId).Clone();
        }
    }

    // ---- F11: an admin can block a slot for an event ----

    [SkippableFact]
    public async Task An_admin_can_block_a_slot_and_the_grid_shows_it_as_a_block()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);
        var startsAt = NextDayAt(9);

        var created = await admin.PostAsJsonAsync("/api/v1/admin/blocks/",
            new { courtId = s.CourtId, startsAt, sliceCount = 4, label = "Tournament" });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);

        var day = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/schedule?date={startsAt.UtcDateTime:yyyy-MM-dd}");
        var slot = day.GetProperty("slots").EnumerateArray().Single(x => x.GetProperty("blockLabel").GetString() == "Tournament");
        // `SlotCell` has been able to RENDER `adminblock` since it was written; nothing in
        // the product could create one, so the branch was unreachable code.
        Assert.Equal("adminblock", slot.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, slot.GetProperty("ownerUserId").ValueKind);

        // And the court is genuinely reserved, decided by the exclusion constraint rather
        // than by whoever asked first.
        var (status, body) = await PostBookingAsync(ClientFor(factory, s, s.MemberUserId), s.CourtId, startsAt);
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("slot_taken", body.GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task A_block_cannot_be_laid_over_a_members_paid_booking()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var startsAt = NextDayAt(9);
        await BookAsync(ClientFor(factory, s, s.MemberUserId), s.CourtId, startsAt);

        var res = await ClientFor(factory, s, s.AdminUserId, isAdmin: true).PostAsJsonAsync(
            "/api/v1/admin/blocks/", new { courtId = s.CourtId, startsAt, sliceCount = 1, label = "Maintenance" });

        // A member who paid for a court must be refunded deliberately, not overwritten by
        // a block that takes no money and leaves no ledger row.
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
    }

    [SkippableFact]
    public async Task A_member_cannot_block_a_slot()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        var res = await ClientFor(factory, s, s.MemberUserId).PostAsJsonAsync(
            "/api/v1/admin/blocks/", new { courtId = s.CourtId, startsAt = NextDayAt(9), sliceCount = 1, label = "Mine now" });

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [SkippableFact]
    public async Task Lifting_a_block_frees_the_court_again()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);
        var startsAt = NextDayAt(9);

        var created = await admin.PostAsJsonAsync("/api/v1/admin/blocks/",
            new { courtId = s.CourtId, startsAt, sliceCount = 1, label = "Maintenance" });
        using var createdBody = JsonDocument.Parse(await created.Content.ReadAsStringAsync());
        var blockId = createdBody.RootElement.GetProperty("booking_id").GetGuid();

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/v1/admin/blocks/{blockId}")).StatusCode);

        var (status, _) = await PostBookingAsync(ClientFor(factory, s, s.MemberUserId), s.CourtId, startsAt);
        Assert.Equal(HttpStatusCode.OK, status);
    }
}
