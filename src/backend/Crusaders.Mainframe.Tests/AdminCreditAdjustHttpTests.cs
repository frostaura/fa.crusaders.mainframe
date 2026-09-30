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
/// The desk's manual credit adjustment, posted twice.
///
/// <para>
/// A double-click on Apply put two identical <c>AdminAdjustment</c> rows on the ledger and
/// moved the member's balance twice: 444 → 458 where 7 credits were typed. On a slow club
/// connection, four impatient clicks granted 44 credits where 11 were typed. Money is
/// ledger-only, so a duplicated row <b>is</b> the wrong balance, and there is nothing on
/// the ledger to say which of two identical rows was the mistake — a dispute replayed from
/// the ledger reads them both as real.
/// </para>
///
/// <para>
/// These tests are Postgres-backed for a reason recorded in <c>memory/gotchas.md</c>: the
/// EF in-memory provider does not enforce unique indexes, and the filtered unique index on
/// <c>ledger_entries.ExternalReference</c> is what holds the line when both clicks are in
/// flight at once. A test of this fix on the in-memory provider would pass while proving
/// nothing.
/// </para>
/// </summary>
public sealed class AdminCreditAdjustHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminCreditAdjustHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"adj-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Adjustment Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = "{}" });

        var admin = new User
        {
            TenantId = tenant.Id,
            Email = $"admin-{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = true,
        };
        var member = new User
        {
            TenantId = tenant.Id,
            Email = $"member-{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
        };
        db.Users.AddRange(admin, member);
        db.Memberships.AddRange(
            new Membership
            {
                TenantId = tenant.Id, UserId = admin.Id, FullName = "Desk Admin",
                MembershipNumber = $"A-{slug}"[..12], Status = MembershipStatus.Active,
            },
            new Membership
            {
                TenantId = tenant.Id, UserId = member.Id, FullName = "Naledi Khoza",
                MembershipNumber = $"M-{slug}"[..12], Status = MembershipStatus.Active,
            });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id, member.Id);
    }

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.AdminUserId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
                new Claim(ClaimTypes.Role, "admin"),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", new JwtSecurityTokenHandler().WriteToken(token));
        return client;
    }

    /// <summary>The member's balance, read the only way it is ever true: as a sum of rows.</summary>
    private static async Task<decimal> BalanceAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId)
            .SumAsync(l => (decimal?)l.AmountCredits) ?? 0m;
    }

    private static async Task<int> AdjustmentRowCountAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters()
            .CountAsync(l => l.TenantId == s.TenantId
                && l.UserId == s.MemberUserId
                && l.Type == LedgerEntryType.AdminAdjustment);
    }

    private static Task<HttpResponseMessage> AdjustAsync(
        HttpClient client, Seeded s, decimal amount, string reason, string? idempotencyKey)
    {
        return client.PostAsJsonAsync($"/api/v1/admin/credit/{s.MemberUserId}/adjust", new
        {
            amountCredits = amount,
            reason,
            idempotencyKey,
        });
    }

    /// <summary>
    /// The double-click, sequentially: the second request arrives after the first has
    /// returned, which is what an impatient desk on a working connection produces.
    /// </summary>
    [SkippableFact]
    public async Task A_repeated_adjustment_carrying_the_same_key_moves_the_money_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);
        var key = Guid.NewGuid().ToString("N");

        var first = await AdjustAsync(client, seeded, 7m, "fast dblclick probe", key);
        var second = await AdjustAsync(client, seeded, 7m, "fast dblclick probe", key);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        // The same row, not a second one: the desk sees one success either way, and the
        // second answer is the first answer rather than a 500 beside a movement that did
        // happen.
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        var secondBody = await second.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(firstBody.GetProperty("entry_id").GetGuid(), secondBody.GetProperty("entry_id").GetGuid());

        Assert.Equal(1, await AdjustmentRowCountAsync(factory, seeded));
        Assert.Equal(7m, await BalanceAsync(factory, seeded));
        Assert.Equal(7m, secondBody.GetProperty("balance_after_credits").GetDecimal());
    }

    /// <summary>
    /// The same double-click with both requests genuinely in flight at once. The
    /// read-then-insert check loses this race by construction; the unique filtered index on
    /// <c>ExternalReference</c> is what refuses the second row, and the endpoint turns that
    /// refusal into the first request's answer instead of a 500.
    /// </summary>
    [SkippableFact]
    public async Task Two_simultaneous_clicks_still_post_one_row()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);
        var key = Guid.NewGuid().ToString("N");

        var responses = await Task.WhenAll(
            AdjustAsync(client, seeded, 11m, "double submit probe", key),
            AdjustAsync(client, seeded, 11m, "double submit probe", key),
            AdjustAsync(client, seeded, 11m, "double submit probe", key),
            AdjustAsync(client, seeded, 11m, "double submit probe", key));

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));

        // 44 credits granted where 11 were typed is the finding, verbatim.
        Assert.Equal(1, await AdjustmentRowCountAsync(factory, seeded));
        Assert.Equal(11m, await BalanceAsync(factory, seeded));
    }

    /// <summary>
    /// A second, genuinely-intended adjustment of the same amount for the same reason still
    /// goes through. The key names one movement, not one member and not one amount — a
    /// guard that refused a repeat would be the same bug pointing the other way.
    /// </summary>
    [SkippableFact]
    public async Task A_deliberate_second_adjustment_with_its_own_key_is_posted()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        await AdjustAsync(client, seeded, 7m, "coaching credit", Guid.NewGuid().ToString("N"));
        await AdjustAsync(client, seeded, 7m, "coaching credit", Guid.NewGuid().ToString("N"));

        Assert.Equal(2, await AdjustmentRowCountAsync(factory, seeded));
        Assert.Equal(14m, await BalanceAsync(factory, seeded));
    }

    /// <summary>
    /// An unusable key is refused by name rather than dropped. Silently ignoring it would
    /// take away the protection the caller asked for while answering 200.
    /// </summary>
    [SkippableFact]
    public async Task An_unusable_idempotency_key_is_refused_by_name()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var blank = await AdjustAsync(client, seeded, 5m, "typo", "   ");
        Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);
        Assert.Equal("idempotency_key_invalid",
            (await blank.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        var enormous = await AdjustAsync(client, seeded, 5m, "typo", new string('k', 201));
        Assert.Equal(HttpStatusCode.BadRequest, enormous.StatusCode);

        // Nothing moved on a refusal.
        Assert.Equal(0, await AdjustmentRowCountAsync(factory, seeded));
    }

    /// <summary>
    /// One club's key cannot suppress another club's adjustment. <c>ExternalReference</c> is
    /// unique across every row in the table, not per tenant, so a shared key would otherwise
    /// let tenant A's retry answer with tenant B's ledger row — cross-tenant leakage of a
    /// money row, which <c>CLAUDE.md</c> calls a P0.
    /// </summary>
    [SkippableFact]
    public async Task A_key_used_by_one_club_does_not_suppress_another_clubs_adjustment()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var clubA = await SeedAsync(factory);
        var clubB = await SeedAsync(factory);
        var key = Guid.NewGuid().ToString("N");

        var a = await AdjustAsync(AdminClient(factory, clubA), clubA, 9m, "welcome credit", key);
        var b = await AdjustAsync(AdminClient(factory, clubB), clubB, 9m, "welcome credit", key);

        Assert.Equal(HttpStatusCode.OK, a.StatusCode);

        // Either B is posted normally, or it is refused outright — but B's member must never
        // be told about A's row, and B's money must never silently fail to move while the
        // desk is shown a success carrying A's entry id.
        var aEntry = (await a.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("entry_id").GetGuid();
        if (b.StatusCode == HttpStatusCode.OK)
        {
            var bEntry = (await b.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("entry_id").GetGuid();
            Assert.NotEqual(aEntry, bEntry);
            Assert.Equal(9m, await BalanceAsync(factory, clubB));
        }
        else
        {
            Assert.Equal(0m, await BalanceAsync(factory, clubB));
        }

        Assert.Equal(9m, await BalanceAsync(factory, clubA));
    }

    /// <summary>
    /// The old callers still work. Nothing but the console mints a key, and a script or a
    /// support tool posting by hand has nothing to retry — so an omitted key is allowed and
    /// simply carries no protection.
    /// </summary>
    [SkippableFact]
    public async Task An_adjustment_with_no_key_still_posts()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await AdjustAsync(client, seeded, -5m, "bar tab", null);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(-5m, await BalanceAsync(factory, seeded));
    }

    // ---- "Admins top me up" — the capability, made honest -------------------

    private static Task<HttpResponseMessage> TopUpAsync(
        HttpClient client, Seeded s, decimal amount, string reasonCode, string? idempotencyKey = null)
    {
        return client.PostAsJsonAsync($"/api/v1/admin/credit/{s.MemberUserId}/adjust", new
        {
            amountCredits = amount,
            reason = "R200 cash at the desk, receipt 0412",
            reasonCode,
            zarReceived = 200m,
            idempotencyKey,
        });
    }

    private static async Task<LedgerEntryType> LastTypeAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId)
            .OrderByDescending(l => l.CreatedAt).Select(l => l.Type).FirstAsync();
    }

    /// <summary>
    /// Cash at the desk is REVENUE.
    ///
    /// <para>
    /// <c>docs/specs/reporting.md</c> defines Revenue as <c>top_up</c> net of
    /// <c>payment_reversal</c>, and an <c>AdminAdjustment</c> sits in the Adjustment bucket — so
    /// before this, every rand the club took over the counter was invisible to the club's own
    /// revenue figure. The three top-up codes now post an <c>AdminTopUp</c>, which lives in the
    /// Funding bucket beside a PayFast top-up, because a R200 note and a R200 card payment are
    /// the same event to the club's books.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData("top_up_cash")]
    [InlineData("top_up_eft")]
    [InlineData("top_up_card_offline")]
    public async Task A_desk_top_up_posts_an_AdminTopUp_and_counts_as_funding(string code)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await TopUpAsync(client, seeded, 200m, code);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AdminTopUp", body.GetProperty("type").GetString());
        Assert.Equal(code, body.GetProperty("reason_code").GetString());
        Assert.Equal(200m, body.GetProperty("amount_credits").GetDecimal());

        // The admin reads back where they took the member FROM and TO, in one answer, rather
        // than composing it client-side from a figure fetched before the movement.
        Assert.Equal(0m, body.GetProperty("balance_before_credits").GetDecimal());
        Assert.Equal(200m, body.GetProperty("balance_after_credits").GetDecimal());

        Assert.Equal(LedgerEntryType.AdminTopUp, await LastTypeAsync(factory, seeded));
        Assert.Contains(LedgerEntryType.AdminTopUp, LedgerEntryTypes.Funding);
    }

    /// <summary>And a goodwill credit is not revenue, which is the other half of the same rule.</summary>
    [SkippableTheory]
    [InlineData("goodwill")]
    [InlineData("correction")]
    [InlineData("refund_outside_system")]
    [InlineData("other")]
    public async Task A_gesture_posts_an_AdminAdjustment_and_does_not(string code)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await TopUpAsync(client, seeded, 50m, code);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("AdminAdjustment",
            (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("type").GetString());
        Assert.Equal(LedgerEntryType.AdminAdjustment, await LastTypeAsync(factory, seeded));
    }

    /// <summary>
    /// A top-up is money the club TOOK, so it is strictly positive. A negative one is a refund or
    /// a correction and has codes of its own; mixing signs inside a directional bucket is what
    /// makes a per-row listing unreadable.
    /// </summary>
    [SkippableFact]
    public async Task A_negative_top_up_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await TopUpAsync(client, seeded, -200m, "top_up_cash");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("amount_must_be_positive_for_top_up",
            (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        Assert.Equal(0m, await BalanceAsync(factory, seeded));
    }

    /// <summary>An unknown code is refused with the whole valid set, so a client never has to guess.</summary>
    [SkippableFact]
    public async Task An_unknown_reason_code_is_refused_with_the_valid_set()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await TopUpAsync(client, seeded, 200m, "cash-ish");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("reason_code_invalid", body.GetProperty("error").GetString());
        Assert.Equal(7, body.GetProperty("valid").GetArrayLength());
    }

    /// <summary>
    /// The grace release: a console that has not been updated yet still works, and its movement
    /// lands exactly where it used to.
    /// </summary>
    [SkippableFact]
    public async Task A_request_carrying_no_reason_code_still_works_for_one_release()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await AdjustAsync(client, seeded, 11m, "an older console", idempotencyKey: null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AdminAdjustment", body.GetProperty("type").GetString());
        Assert.Equal("other", body.GetProperty("reason_code").GetString());
    }

    /// <summary>The code binds under the snake_case spelling too — see AdjustRequest.ReasonCodeEither.</summary>
    [SkippableFact]
    public async Task The_reason_code_binds_under_either_spelling()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await client.PostAsJsonAsync($"/api/v1/admin/credit/{seeded.MemberUserId}/adjust", new
        {
            amountCredits = 200m,
            reason = "cash at the desk",
            reason_code = "top_up_cash",
            zar_received = 200m,
        });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("AdminTopUp",
            (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("type").GetString());
    }

    /// <summary>
    /// <b>D2-B10.</b> The replay matched on the reference alone, so +11 under key k1 followed by
    /// +110 under k1 answered 200 with <c>amount_credits: 11</c> — the admin corrected the amount,
    /// pressed Apply, and was told it had been applied.
    /// </summary>
    [SkippableFact]
    public async Task Reusing_a_key_with_a_different_amount_is_refused_rather_than_silently_replayed()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        Assert.Equal(HttpStatusCode.OK, (await AdjustAsync(client, seeded, 11m, "typo", "k1")).StatusCode);

        var corrected = await AdjustAsync(client, seeded, 110m, "the amount I meant", "k1");
        Assert.Equal(HttpStatusCode.Conflict, corrected.StatusCode);

        var body = await corrected.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("idempotency_key_reused", body.GetProperty("error").GetString());
        Assert.Equal(11m, body.GetProperty("stored").GetProperty("amount_credits").GetDecimal());

        // And nothing moved on the second attempt.
        Assert.Equal(11m, await BalanceAsync(factory, seeded));
    }

    /// <summary>The same key with the same payload is still a retry, and still replays.</summary>
    [SkippableFact]
    public async Task Reusing_a_key_with_the_same_payload_replays()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        Assert.Equal(HttpStatusCode.OK, (await AdjustAsync(client, seeded, 11m, "once", "k1")).StatusCode);

        var again = await AdjustAsync(client, seeded, 11m, "once", "k1");
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);

        var body = await again.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(11m, body.GetProperty("amount_credits").GetDecimal());
        Assert.Equal(0m, body.GetProperty("balance_before_credits").GetDecimal());
        Assert.Equal(11m, body.GetProperty("balance_after_credits").GetDecimal());
        Assert.Equal(11m, await BalanceAsync(factory, seeded));
    }

    /// <summary>
    /// <b>D2-B08.</b> The one by-hand money movement in the system wrote nothing to the club's
    /// audit trail, while a member-class change and a password reset both write one. The two
    /// balance figures are the point: an adjustment is only reviewable if the row says where it
    /// took the member from and to.
    /// </summary>
    [SkippableFact]
    public async Task A_by_hand_movement_writes_an_audit_row_carrying_both_balances()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        Assert.Equal(HttpStatusCode.OK, (await TopUpAsync(client, seeded, 200m, "top_up_cash")).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == seeded.TenantId && a.Action == "credit.adjusted").ToListAsync());

        Assert.Equal(seeded.AdminUserId, row.ActorUserId);
        Assert.Equal(seeded.MemberUserId, row.SubjectUserId);

        var details = JsonDocument.Parse(row.DetailsJson!).RootElement;
        Assert.Equal("AdminTopUp", details.GetProperty("entry_type").GetString());
        Assert.Equal("top_up_cash", details.GetProperty("reason_code").GetString());
        Assert.Equal(0m, details.GetProperty("balance_before_credits").GetDecimal());
        Assert.Equal(200m, details.GetProperty("balance_after_credits").GetDecimal());
    }

    /// <summary>
    /// And the member is told, live. GOAL item 8 asks the credits badge to animate when funds
    /// ARRIVE, which a bare new-total cannot distinguish from a refund — so the named frame
    /// carries the delta and the reason.
    /// </summary>
    [SkippableFact]
    public async Task A_desk_top_up_reaches_the_members_live_wallet_with_a_delta_and_a_reason()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var bus = factory.Services.GetRequiredService<Crusaders.Mainframe.Api.Services.Realtime.IRealtimeBus>();
        var topic = Crusaders.Mainframe.Api.Services.Realtime.RealtimeTopic.Wallet(
            seeded.TenantId, seeded.MemberUserId);
        var channel = bus.Subscribe(topic);

        try
        {
            Assert.Equal(HttpStatusCode.OK, (await TopUpAsync(client, seeded, 200m, "top_up_cash")).StatusCode);

            var frames = new List<Crusaders.Mainframe.Api.Services.Realtime.RealtimeMessage>();
            while (channel.Reader.TryRead(out var frame)) frames.Add(frame);

            var named = Assert.Single(frames, f => f.Event == "balance");
            Assert.Contains("\"delta_credits\":200", named.JsonPayload);
            Assert.Contains("\"reason\":\"admin_top_up\"", named.JsonPayload);
        }
        finally
        {
            bus.Unsubscribe(topic, channel);
        }
    }
}
