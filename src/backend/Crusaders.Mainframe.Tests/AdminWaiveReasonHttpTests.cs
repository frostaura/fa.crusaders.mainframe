using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>feature-spec.md</c> §7 — "Admin can choose to waive the penalty (<b>logged with
/// reason</b>)" — and §8's restatement, "penalty waiveable <b>with reason</b>", over real
/// HTTP.
///
/// <para>
/// The reason did not exist anywhere: not on the modal, not on <c>AdminCancelRequest</c>,
/// not in the audit row, which carried a bare <c>waived: true</c>. A club reviewing waived
/// penalties at month end therefore had a boolean and no way to tell a genuine club
/// decision — a flooded court, an injury — from a desk quietly writing one off for a
/// friend. That is precisely the distinction the audit trail exists to preserve.
/// </para>
///
/// <para>
/// Postgres-backed rather than in-memory because this is the money path, and because the
/// audit row and the ledger rows have to be committed by the same save the cancellation
/// makes: the in-memory provider has no transaction, so a test written against it can pass
/// while demonstrating the failure it was meant to catch (<c>memory/gotchas.md</c>).
/// </para>
/// </summary>
public sealed class AdminWaiveReasonHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminWaiveReasonHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const decimal SlicePriceCredits = 50m;
    private const decimal FloatCredits = 500m;

    /// <summary>Hours 00:00–24:00 and no reachable peak window, so the clock the suite runs at is irrelevant.</summary>
    private const string SettingsJson = """
        {"slice_minutes":15,"slice_price_credits":50,"penalty_pct":30,"grace_window_minutes":5,
         "penalty_window_minutes":15,"advance_booking_days":14,"timezone":"UTC",
         "member_per_day_max_minutes":600,"peak_hours":"16:00-19:00","peak_advance_hours_for_regular":1,
         "day_start_minute":0,"day_end_minute":1440}
        """;

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId, Guid BookingId);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>
    /// A booking already paid for and starting in five minutes, so the cancellation is
    /// unambiguously INSIDE the 15-minute penalty window and a penalty genuinely exists to
    /// waive. Written straight to the database rather than booked through the API: the
    /// booking rules are pinned elsewhere, and a slot this close to now would drag peak
    /// hours and slice alignment into a test about an audit field.
    /// </summary>
    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"wv-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Waiver Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = SettingsJson });

        var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"member-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);
        db.Memberships.AddRange(
            new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Desk Admin", MembershipNumber = $"{slug}-A", Status = MembershipStatus.Active },
            new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Naledi Khoza", MembershipNumber = $"{slug}-M", Status = MembershipStatus.Active });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = SlicePriceCredits };
        db.Courts.Add(court);

        var starts = DateTimeOffset.UtcNow.AddMinutes(5);
        var booking = new Booking
        {
            TenantId = tenant.Id,
            CourtId = court.Id,
            UserId = member.Id,
            BookedByUserId = member.Id,
            PaidByUserId = member.Id,
            ActorUserId = member.Id,
            StartsAt = starts,
            EndsAt = starts.AddMinutes(15),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = SlicePriceCredits,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);

        db.LedgerEntries.AddRange(
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, ActorUserId = admin.Id,
                Type = LedgerEntryType.AdminAdjustment, AmountCredits = FloatCredits, Reason = "Seed float",
            },
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, ActorUserId = member.Id,
                Type = LedgerEntryType.BookingCharge, AmountCredits = -SlicePriceCredits,
                RelatedBookingId = booking.Id, Reason = "Booking charge",
            });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id, member.Id, booking.Id);
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

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TokenFor(s, s.AdminUserId, isAdmin: true));
        return client;
    }

    private static async Task<(HttpStatusCode Status, JsonElement Body)> PostAsync(HttpClient client, string path, object body)
    {
        var res = await client.PostAsJsonAsync(path, body);
        var text = await res.Content.ReadAsStringAsync();
        using var doc = string.IsNullOrWhiteSpace(text) ? JsonDocument.Parse("{}") : JsonDocument.Parse(text);
        return (res.StatusCode, doc.RootElement.Clone());
    }

    private static string CancelPath(Guid bookingId) => $"/api/v1/admin/bookings/{bookingId}/cancel";

    private static async Task<JsonElement> CancellationAuditAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == s.TenantId && a.Action == "booking.cancelled").ToListAsync());
        Assert.Equal(s.AdminUserId, audit.ActorUserId);
        Assert.Equal(s.MemberUserId, audit.SubjectUserId);
        using var details = JsonDocument.Parse(audit.DetailsJson!);
        return details.RootElement.Clone();
    }

    /// <summary>
    /// The waiver carries its reason all the way to the audit row. Without it the row says
    /// only that a penalty was waived, which answers "how many" and never "why".
    /// </summary>
    [SkippableFact]
    public async Task A_waived_penalty_records_the_reason_the_admin_gave()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        var (status, body) = await PostAsync(AdminClient(factory, s), CancelPath(s.BookingId),
            new { waivePenalty = true, waiveReason = "Court flooded — club's fault" });

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(SlicePriceCredits, body.GetProperty("refunded_credits").GetDecimal());
        Assert.Equal(0m, body.GetProperty("penalty_credits").GetDecimal());

        var details = await CancellationAuditAsync(factory, s);
        Assert.True(details.GetProperty("waived").GetBoolean());
        Assert.Equal("Court flooded — club's fault", details.GetProperty("waive_reason").GetString());
    }

    /// <summary>
    /// Refused, not defaulted. An audit field that may be left blank is one that always is,
    /// and the whole value of the reason is that a month-end review can rely on it being
    /// there. Nothing is cancelled and no money moves.
    /// </summary>
    [SkippableFact]
    public async Task A_waiver_without_a_reason_is_refused_and_cancels_nothing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        var (status, body) = await PostAsync(AdminClient(factory, s), CancelPath(s.BookingId),
            new { waivePenalty = true, waiveReason = "   " });

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal("waive_reason_required", body.GetProperty("error").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == s.BookingId);
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.Empty(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == s.TenantId && a.Action == "booking.cancelled").ToListAsync());
        Assert.Equal(FloatCredits - SlicePriceCredits, await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId).SumAsync(l => l.AmountCredits));
    }

    /// <summary>
    /// A cancellation that waives nothing needs no reason — the field is required by the
    /// waiver, not by the route — and the penalty is still taken. This is what stops the
    /// new requirement from quietly becoming "an admin cannot cancel without paperwork".
    /// </summary>
    [SkippableFact]
    public async Task An_ordinary_admin_cancellation_needs_no_reason_and_still_takes_the_penalty()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        var (status, body) = await PostAsync(AdminClient(factory, s), CancelPath(s.BookingId), new { waivePenalty = false });

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(SlicePriceCredits * 0.30m, body.GetProperty("penalty_credits").GetDecimal());

        var details = await CancellationAuditAsync(factory, s);
        Assert.False(details.GetProperty("waived").GetBoolean());
        // Present and null rather than absent, so a reader never has to guess whether an
        // older row simply predates the field. Null because the desk typed nothing — not
        // because nothing was waived; see the test below for that distinction.
        Assert.Equal(JsonValueKind.Null, details.GetProperty("waive_reason").ValueKind);
    }

    /// <summary>
    /// A reason typed on a cancellation that waives nothing is still the club's reason, and
    /// it still reaches the club's own record — over real HTTP, from the shape the console
    /// actually sends.
    ///
    /// <para>
    /// The field was briefly gated on the derived waiver, so an admin who cancelled a court
    /// and said why left a row reading <c>{"waived": false, "waive_reason": null}</c> and a
    /// mail with no reason line in it at all. <c>bookings.cancellation_reason</c> is no help
    /// there — it is the displacement marker the resale path writes <c>ResoldTailRefunded</c>
    /// into and the money path reads back (<c>settlement-model.md</c> I5 / S8), and this path
    /// never writes it — so this row is the whole of the club's memory of why it cancelled
    /// somebody's booking; a gate here does not tidy it, it erases it.
    /// </para>
    ///
    /// <para>
    /// The penalty is still taken, which is the point of the pairing: the reason travelling
    /// is not the club quietly waiving anything.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_cancellation_that_waives_nothing_still_records_the_reason_the_admin_typed()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        var (status, body) = await PostAsync(AdminClient(factory, s), CancelPath(s.BookingId),
            new { waivePenalty = false, waiveReason = "Court flooded" });

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(SlicePriceCredits * 0.30m, body.GetProperty("penalty_credits").GetDecimal());

        var details = await CancellationAuditAsync(factory, s);
        Assert.False(details.GetProperty("waived").GetBoolean());
        Assert.Equal("Court flooded", details.GetProperty("waive_reason").GetString());
    }

    /// <summary>
    /// Blank is not a reason. A whitespace-only string on a cancellation that waives nothing
    /// is not refused — the route's requirement belongs to the waiver — but neither is it
    /// written into the audit row as an empty string a month-end reader would have to squint
    /// at. Null means "nobody said why", and it has to keep meaning only that.
    /// </summary>
    [SkippableFact]
    public async Task A_blank_reason_is_recorded_as_nothing_rather_than_as_an_empty_string()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        var (status, _) = await PostAsync(AdminClient(factory, s), CancelPath(s.BookingId),
            new { waivePenalty = false, waiveReason = "   " });

        Assert.Equal(HttpStatusCode.OK, status);

        var details = await CancellationAuditAsync(factory, s);
        Assert.Equal(JsonValueKind.Null, details.GetProperty("waive_reason").ValueKind);
    }
}
