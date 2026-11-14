using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 6 — what an admin reads about a member afterwards: a no-show refunded in full
/// because no box was reachable (E6-6), the bookings list's end and cost on a swept no-show
/// (E6-10), the spend report's buckets (E6-12) and the sign-in route's answer to an empty body
/// (J6-10).
/// </summary>
public sealed class R6AdminRecordHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<(MemberCodeClub Club, WebApplicationFactory<Program> App)> RigAsync(TestWebAppFactory factory, string prefix)
    {
        var app = MemberCodeClub.Wired(factory, new StubEmailService());
        return (await MemberCodeClub.SeedAsync(app, prefix), app);
    }

    private sealed record Swept(Booking Dark, Booking Missed);

    /// <summary>
    /// Two of Olga's bookings swept in one tick: court 1's only box has been silent for a day, so
    /// that one is refunded in full with no penalty (§6a); court 2 has no box at all, so the other
    /// is an ordinary no-show — refunded less 30%, and cut to the sweep's clock mid-slot.
    /// </summary>
    private static async Task<Swept> SweepAsync(MemberCodeClub c, WebApplicationFactory<Program> app)
    {
        await c.WriteAsync(app, async db =>
        {
            var box = await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.TenantId == c.TenantId && d.Kind == DeviceKind.CourtBox);
            box.CourtNumbers = [1];
            box.CreatedAt = DateTimeOffset.UtcNow.AddDays(-3);
            box.LastSeenAt = DateTimeOffset.UtcNow.AddDays(-1);
        });
        var dark = await c.BookAsync(app, c.Olga, courtIndex: 0, startsInMinutes: -60, minutes: 45);
        var missed = await c.BookAsync(app, c.Olga, courtIndex: 1, startsInMinutes: -20, minutes: 45);

        var worker = new NoShowWorker(app.Services, app.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance);
        await worker.TickAsync(default);

        var statuses = await c.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == c.TenantId).Select(b => b.Status).ToListAsync());
        Assert.All(statuses, s => Assert.Equal(BookingStatus.NoShow, s));
        return new Swept(dark, missed);
    }

    /// <summary>
    /// E6-6: the member was mailed "you have not been marked down for missing it" while the
    /// admin's record counted the booking as a no-show — "No-shows 2" for one real miss. A no-show
    /// refunded because no box was reachable is not counted or labelled one anywhere an admin
    /// looks; the settlement itself (status, money) is untouched.
    /// </summary>
    [SkippableFact]
    public async Task A_no_show_refunded_because_the_box_was_dark_is_not_a_no_show_to_the_admin()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var (c, app) = await RigAsync(factory, "r6dark");
        await using var owned = app;
        var swept = await SweepAsync(c, app);
        var admin = c.Member(app, c.AdminId, "admin");

        // The money is the settlement's, unchanged: the dark one refunded in full, the other less 13.
        Assert.Equal(200 - 13, await c.BalanceAsync(app, c.Olga));

        var detail = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{c.Olga}/");
        Assert.Equal(1, detail.GetProperty("counts_30d").GetProperty("no_shows").GetInt32());

        var past = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{c.Olga}/bookings?when=past");
        var rows = past.GetProperty("items").EnumerateArray().ToDictionary(r => r.GetProperty("booking_id").GetGuid());
        Assert.Equal("refunded_outage", rows[swept.Dark.Id].GetProperty("status").GetString());
        Assert.Equal("noshow", rows[swept.Missed.Id].GetProperty("status").GetString());

        var darkDetail = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{swept.Dark.Id}");
        var missedDetail = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{swept.Missed.Id}");
        Assert.True(darkDetail.GetProperty("refunded_for_outage").GetBoolean());
        Assert.False(missedDetail.GetProperty("refunded_for_outage").GetBoolean());

        var report = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/reports/no-shows");
        Assert.Equal(1, report.GetProperty("no_show").GetInt32());
        var daily = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/reports/daily");
        Assert.Equal(1, daily.EnumerateArray().Sum(d => d.GetProperty("no_shows").GetInt32()));
    }

    /// <summary>
    /// E6-10: the admin's list showed a swept no-show as "01:55–02:00 · 45 min" — the sweep's cut
    /// end and the gross charge — where the member's own page said "01:55–02:40 · cost 13". The
    /// row carries the end it was sold to and what the member is actually out.
    /// </summary>
    [SkippableFact]
    public async Task The_admins_list_shows_a_swept_no_show_at_its_sold_end_and_its_real_cost()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var (c, app) = await RigAsync(factory, "r6cost");
        await using var owned = app;
        var swept = await SweepAsync(c, app);
        var admin = c.Member(app, c.AdminId, "admin");

        var past = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{c.Olga}/bookings?when=past");
        var rows = past.GetProperty("items").EnumerateArray().ToDictionary(r => r.GetProperty("booking_id").GetGuid());
        var missed = rows[swept.Missed.Id];
        Assert.Equal(swept.Missed.StartsAt.AddMinutes(45), missed.GetProperty("sold_ends_at").GetDateTimeOffset());
        Assert.True(missed.GetProperty("ends_at").GetDateTimeOffset() < swept.Missed.StartsAt.AddMinutes(45), "the sweep cut the slot");
        Assert.Equal(45, missed.GetProperty("charged_minutes").GetInt32());
        Assert.Equal(13, missed.GetProperty("cost_minutes").GetInt32());
        Assert.Equal(0, rows[swept.Dark.Id].GetProperty("cost_minutes").GetInt32());
    }

    /// <summary>
    /// E6-12: the per-member spend report's buckets did not add up to its own net — shares moved
    /// between players and reversals had no bucket — and it still carried the retired
    /// <c>member_class</c>.
    /// </summary>
    [SkippableFact]
    public async Task The_spend_reports_buckets_add_up_to_its_net_and_it_names_no_member_class()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var (c, app) = await RigAsync(factory, "r6spend");
        await using var owned = app;
        var booking = await c.BookAsync(app, c.Olga, courtIndex: 1, startsInMinutes: 60);
        await c.WriteAsync(app, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = c.TenantId,
                UserId = c.Olga,
                Type = LedgerEntryType.ShareTransfer,
                AmountMinutes = 15,
                ActorUserId = c.Pam,
                RelatedBookingId = booking.Id,
                Reason = "share",
                ExternalReference = $"share:{Guid.NewGuid():N}:1:in",
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = c.TenantId,
                UserId = c.Olga,
                Type = LedgerEntryType.PaymentReversal,
                AmountMinutes = -20,
                ActorUserId = c.AdminId,
                Reason = "chargeback",
            });
            return Task.CompletedTask;
        });

        var admin = c.Member(app, c.AdminId, "admin");
        var spend = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{c.OlgaMembership}/spend");
        Assert.False(spend.GetProperty("member").TryGetProperty("member_class", out _));

        foreach (var bucket in spend.GetProperty("monthly").EnumerateArray().Append(spend.GetProperty("totals")))
        {
            var sum = bucket.GetProperty("top_ups_minutes").GetInt32()
                      - bucket.GetProperty("spent_minutes").GetInt32()
                      + bucket.GetProperty("refunds_minutes").GetInt32()
                      - bucket.GetProperty("penalties_minutes").GetInt32()
                      + bucket.GetProperty("adjustments_minutes").GetInt32()
                      + bucket.GetProperty("reversals_minutes").GetInt32()
                      + bucket.GetProperty("share_transfers_minutes").GetInt32();
            Assert.Equal(bucket.GetProperty("net_minutes").GetInt32(), sum);
        }
        Assert.Equal(15, spend.GetProperty("totals").GetProperty("share_transfers_minutes").GetInt32());
        Assert.Equal(-20, spend.GetProperty("totals").GetProperty("reversals_minutes").GetInt32());
    }

    /// <summary>J6-10: a sign-in with an empty body answered 500 <c>internal_error</c>. It is a 400.</summary>
    [SkippableTheory]
    [InlineData("{}")]
    [InlineData("""{"email":"someone@test.local"}""")]
    [InlineData("""{"password":"OldPass!123"}""")]
    [InlineData("""{"email":null,"password":null}""")]
    public async Task A_sign_in_missing_its_fields_is_a_400_not_a_500(string body)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var (c, app) = await RigAsync(factory, "r6login");
        await using var owned = app;
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Host = $"{c.Slug}.crusaders.test";

        var response = await client.PostAsync("/api/v1/auth/login", new StringContent(body, Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("missing_fields", await response.Content.ReadAsStringAsync());
    }

    /// <summary>The same shape on the two other sign-in-adjacent routes that dereferenced a missing field.</summary>
    [SkippableTheory]
    [InlineData("/api/v1/auth/forgot-password")]
    [InlineData("/api/v1/auth/reset-password")]
    public async Task The_password_routes_refuse_an_empty_body_with_a_400(string path)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var (c, app) = await RigAsync(factory, "r6pwd");
        await using var owned = app;
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Host = $"{c.Slug}.crusaders.test";

        var response = await client.PostAsync(path, new StringContent("{}", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
