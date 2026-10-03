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
/// The desk moving a member's minutes by hand (P13 §3.7): an adjustment, and a package sold at
/// the counter — both idempotent on the caller's key, both on the club's records.
///
/// <para>
/// A double-click on Apply put two identical <c>AdminAdjustment</c> rows on the ledger and
/// moved the member's balance twice: 444 → 458 where 7 minutes were typed. On a slow club
/// connection, four impatient clicks granted 44 minutes where 11 were typed. Money is
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

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId, Guid FiveHours);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

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
        await MinutePackageSeeder.EnsureAsync(db, tenant.Id, admin.Id);
        var fiveHours = await db.MinutePackages.IgnoreQueryFilters()
            .Where(p => p.TenantId == tenant.Id && p.Minutes == 300).Select(p => p.Id).SingleAsync();
        return new Seeded(tenant.Id, slug, admin.Id, member.Id, fiveHours);
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
            .SumAsync(l => (decimal?)l.AmountMinutes) ?? 0;
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
        return client.PostAsJsonAsync($"/api/v1/admin/minutes/{s.MemberUserId}/adjust", new
        {
            amountMinutes = amount,
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

        var first = await AdjustAsync(client, seeded, 7, "fast dblclick probe", key);
        var second = await AdjustAsync(client, seeded, 7, "fast dblclick probe", key);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        // The same row, not a second one: the desk sees one success either way, and the
        // second answer is the first answer rather than a 500 beside a movement that did
        // happen.
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        var secondBody = await second.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(firstBody.GetProperty("entry_id").GetGuid(), secondBody.GetProperty("entry_id").GetGuid());

        Assert.Equal(1, await AdjustmentRowCountAsync(factory, seeded));
        Assert.Equal(7, await BalanceAsync(factory, seeded));
        Assert.Equal(7m, secondBody.GetProperty("balance_after_minutes").GetDecimal());
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
            AdjustAsync(client, seeded, 11, "double submit probe", key),
            AdjustAsync(client, seeded, 11, "double submit probe", key),
            AdjustAsync(client, seeded, 11, "double submit probe", key),
            AdjustAsync(client, seeded, 11, "double submit probe", key));

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));

        // 44 credits granted where 11 were typed is the finding, verbatim.
        Assert.Equal(1, await AdjustmentRowCountAsync(factory, seeded));
        Assert.Equal(11, await BalanceAsync(factory, seeded));
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

        await AdjustAsync(client, seeded, 7, "coaching credit", Guid.NewGuid().ToString("N"));
        await AdjustAsync(client, seeded, 7, "coaching credit", Guid.NewGuid().ToString("N"));

        Assert.Equal(2, await AdjustmentRowCountAsync(factory, seeded));
        Assert.Equal(14, await BalanceAsync(factory, seeded));
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

        var blank = await AdjustAsync(client, seeded, 5, "typo", "   ");
        Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);
        Assert.Equal("idempotency_key_invalid",
            (await blank.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        var enormous = await AdjustAsync(client, seeded, 5, "typo", new string('k', 201));
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

        var a = await AdjustAsync(AdminClient(factory, clubA), clubA, 9, "welcome credit", key);
        var b = await AdjustAsync(AdminClient(factory, clubB), clubB, 9, "welcome credit", key);

        Assert.Equal(HttpStatusCode.OK, a.StatusCode);

        // Either B is posted normally, or it is refused outright — but B's member must never
        // be told about A's row, and B's money must never silently fail to move while the
        // desk is shown a success carrying A's entry id.
        var aEntry = (await a.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("entry_id").GetGuid();
        if (b.StatusCode == HttpStatusCode.OK)
        {
            var bEntry = (await b.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("entry_id").GetGuid();
            Assert.NotEqual(aEntry, bEntry);
            Assert.Equal(9, await BalanceAsync(factory, clubB));
        }
        else
        {
            Assert.Equal(0, await BalanceAsync(factory, clubB));
        }

        Assert.Equal(9, await BalanceAsync(factory, clubA));
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

        var res = await AdjustAsync(client, seeded, -5, "bar tab", null);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(-5, await BalanceAsync(factory, seeded));
    }

    // ---- "Admins top me up" — the capability, made honest -------------------

    /// <summary>A package sold at the desk (P13 §3.7): the 5-hour package unless told otherwise.</summary>
    private static Task<HttpResponseMessage> SellAsync(
        HttpClient client, Seeded s, string reasonCode, decimal? zarReceived = null, string? idempotencyKey = null, Guid? packageId = null)
    {
        return client.PostAsJsonAsync($"/api/v1/admin/minutes/{s.MemberUserId}/sell", new
        {
            packageId = packageId ?? s.FiveHours,
            reason = "Cash at the desk, receipt 0412",
            reasonCode,
            zarReceived,
            idempotencyKey,
            quotedPriceZar = 550m,   // J9-1: the 5-hour package's shelf price, as the desk was shown it
        });
    }

    private static Task<HttpResponseMessage> AdjustWithCodeAsync(HttpClient client, Seeded s, long amount, string reasonCode)
    {
        return client.PostAsJsonAsync($"/api/v1/admin/minutes/{s.MemberUserId}/adjust", new
        {
            amountMinutes = amount,
            reason = "Sorry about the lights",
            reasonCode,
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
    /// before the sale codes, every rand the club took over the counter was invisible to the
    /// club's own revenue figure. A sale posts an <c>AdminTopUp</c> for the package's minutes,
    /// with the rand taken — by default the member's shelf price.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData("top_up_cash")]
    [InlineData("top_up_eft")]
    [InlineData("top_up_card_offline")]
    public async Task A_desk_sale_posts_an_AdminTopUp_for_the_packages_minutes_and_counts_as_funding(string code)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await SellAsync(client, seeded, code);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AdminTopUp", body.GetProperty("type").GetString());
        Assert.Equal(code, body.GetProperty("reason_code").GetString());
        Assert.Equal(300, body.GetProperty("amount_minutes").GetInt32());
        Assert.Equal(550m, body.GetProperty("zar_received").GetDecimal());
        Assert.Equal(seeded.FiveHours, body.GetProperty("package").GetProperty("id").GetGuid());
        Assert.Equal("5 hours", body.GetProperty("package").GetProperty("name").GetString());
        Assert.Equal(550m, body.GetProperty("package").GetProperty("price_zar").GetDecimal());

        // The admin reads back where they took the member FROM and TO, in one answer.
        Assert.Equal(0, body.GetProperty("balance_before_minutes").GetInt32());
        Assert.Equal(300, body.GetProperty("balance_after_minutes").GetInt32());

        Assert.Equal(LedgerEntryType.AdminTopUp, await LastTypeAsync(factory, seeded));
        Assert.Contains(LedgerEntryType.AdminTopUp, LedgerEntryTypes.Funding);
    }

    /// <summary>The desk may state rand that differs from the price — a rounded cash sale is the desk's call to record.</summary>
    [SkippableFact]
    public async Task A_desk_sale_records_the_rand_the_desk_states()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await SellAsync(client, seeded, "top_up_cash", zarReceived: 500m);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(500m, (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("zar_received").GetDecimal());

        foreach (var (zar, error) in new[] { (-1m, "zar_received_out_of_range"), (1_000_000.01m, "zar_received_out_of_range"), (10.005m, "zar_received_not_whole_cents") })
        {
            var bad = await SellAsync(client, seeded, "top_up_cash", zarReceived: zar);
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
            Assert.Equal(error, (await bad.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }
        Assert.Equal(300, await BalanceAsync(factory, seeded));
    }

    /// <summary>And a goodwill movement is not revenue, which is the other half of the same rule.</summary>
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

        var res = await AdjustWithCodeAsync(client, seeded, 50, code);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AdminAdjustment", body.GetProperty("type").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("zar_received").ValueKind);
        Assert.False(body.TryGetProperty("package", out _));
        Assert.Equal(LedgerEntryType.AdminAdjustment, await LastTypeAsync(factory, seeded));
    }

    /// <summary>
    /// A sale is its own route (P13 §12.8): a top-up code on <c>/adjust</c> is refused with the
    /// four adjustment codes, and an adjustment code on <c>/sell</c> with the three sale codes.
    /// Nothing moves either way.
    /// </summary>
    [SkippableFact]
    public async Task Each_route_refuses_the_others_codes_with_its_own_valid_set()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var onAdjust = await AdjustWithCodeAsync(client, seeded, 200, "top_up_cash");
        Assert.Equal(HttpStatusCode.BadRequest, onAdjust.StatusCode);
        var adjustBody = await onAdjust.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("reason_code_invalid", adjustBody.GetProperty("error").GetString());
        Assert.Equal(["goodwill", "correction", "refund_outside_system", "other"],
            adjustBody.GetProperty("valid").EnumerateArray().Select(v => v.GetString()));

        var onSell = await SellAsync(client, seeded, "goodwill");
        Assert.Equal(HttpStatusCode.BadRequest, onSell.StatusCode);
        var sellBody = await onSell.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("reason_code_invalid", sellBody.GetProperty("error").GetString());
        Assert.Equal(["top_up_cash", "top_up_eft", "top_up_card_offline", "package_free"],
            sellBody.GetProperty("valid").EnumerateArray().Select(v => v.GetString()));

        Assert.Equal(0, await BalanceAsync(factory, seeded));
    }

    /// <summary>
    /// Whole minutes only (P13 §3.7): 0 is <c>amount_zero</c>; past ±999 999 is
    /// <c>amount_out_of_range</c> with <c>max_minutes</c>; a fraction of a minute never binds — a
    /// 400 with nothing posted, rather than a balance rounded into something the desk did not type.
    /// The bounds themselves are accepted.
    /// </summary>
    [SkippableFact]
    public async Task An_adjustment_is_whole_minutes_inside_its_bound()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);
        var path = $"/api/v1/admin/minutes/{seeded.MemberUserId}/adjust";

        var zero = await AdjustWithCodeAsync(client, seeded, 0, "goodwill");
        Assert.Equal("amount_zero", (await zero.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        var over = await AdjustWithCodeAsync(client, seeded, 1_000_000, "goodwill");
        Assert.Equal(HttpStatusCode.BadRequest, over.StatusCode);
        var overBody = await over.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("amount_out_of_range", overBody.GetProperty("error").GetString());
        Assert.Equal(999_999, overBody.GetProperty("max_minutes").GetInt32());

        var fraction = await client.PostAsync(path, new StringContent(
            """{"amountMinutes":30.5,"reason":"half a minute","reasonCode":"goodwill"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, fraction.StatusCode);
        Assert.Equal(0, await BalanceAsync(factory, seeded));

        Assert.Equal(HttpStatusCode.OK, (await AdjustWithCodeAsync(client, seeded, 999_999, "correction")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await AdjustWithCodeAsync(client, seeded, -999_999, "correction")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await AdjustWithCodeAsync(client, seeded, 1, "correction")).StatusCode);
        Assert.Equal(1, await BalanceAsync(factory, seeded));
    }

    /// <summary>An unknown code is refused with the whole valid set, so a client never has to guess.</summary>
    [SkippableFact]
    public async Task An_unknown_reason_code_is_refused_with_the_valid_set()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var res = await AdjustWithCodeAsync(client, seeded, 200, "cash-ish");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("reason_code_invalid", body.GetProperty("error").GetString());
        Assert.Equal(4, body.GetProperty("valid").GetArrayLength());
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

        var res = await AdjustAsync(client, seeded, 11, "an older console", idempotencyKey: null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AdminAdjustment", body.GetProperty("type").GetString());
        Assert.Equal("other", body.GetProperty("reason_code").GetString());
    }

    /// <summary>The code and the rand bind under the snake_case spelling too, on both routes.</summary>
    [SkippableFact]
    public async Task The_reason_code_binds_under_either_spelling()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var sale = await client.PostAsJsonAsync($"/api/v1/admin/minutes/{seeded.MemberUserId}/sell", new
        {
            packageId = seeded.FiveHours,
            reason = "cash at the desk",
            reason_code = "top_up_cash",
            zar_received = 540m,
        });
        Assert.Equal(HttpStatusCode.OK, sale.StatusCode);
        var saleBody = await sale.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AdminTopUp", saleBody.GetProperty("type").GetString());
        Assert.Equal(540m, saleBody.GetProperty("zar_received").GetDecimal());

        var adjust = await client.PostAsJsonAsync($"/api/v1/admin/minutes/{seeded.MemberUserId}/adjust", new
        {
            amountMinutes = 15,
            reason = "lights",
            reason_code = "correction",
        });
        Assert.Equal(HttpStatusCode.OK, adjust.StatusCode);
        Assert.Equal("correction", (await adjust.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason_code").GetString());
    }

    /// <summary>
    /// <b>D2-B10.</b> The replay matched on the reference alone, so +11 under key k1 followed by
    /// +110 under k1 answered 200 with <c>amount_minutes: 11</c> — the admin corrected the amount,
    /// pressed Apply, and was told it had been applied.
    /// </summary>
    [SkippableFact]
    public async Task Reusing_a_key_with_a_different_amount_is_refused_rather_than_silently_replayed()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        Assert.Equal(HttpStatusCode.OK, (await AdjustAsync(client, seeded, 11, "typo", "k1")).StatusCode);

        var corrected = await AdjustAsync(client, seeded, 110, "the amount I meant", "k1");
        Assert.Equal(HttpStatusCode.Conflict, corrected.StatusCode);

        var body = await corrected.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("idempotency_key_reused", body.GetProperty("error").GetString());
        Assert.Equal(11m, body.GetProperty("stored").GetProperty("amount_minutes").GetDecimal());

        // And nothing moved on the second attempt.
        Assert.Equal(11, await BalanceAsync(factory, seeded));
    }

    /// <summary>The same key with the same payload is still a retry, and still replays.</summary>
    [SkippableFact]
    public async Task Reusing_a_key_with_the_same_payload_replays()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        Assert.Equal(HttpStatusCode.OK, (await AdjustAsync(client, seeded, 11, "once", "k1")).StatusCode);

        var again = await AdjustAsync(client, seeded, 11, "once", "k1");
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);

        var body = await again.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(11m, body.GetProperty("amount_minutes").GetDecimal());
        Assert.Equal(0m, body.GetProperty("balance_before_minutes").GetDecimal());
        Assert.Equal(11m, body.GetProperty("balance_after_minutes").GetDecimal());
        Assert.Equal(11, await BalanceAsync(factory, seeded));
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

        Assert.Equal(HttpStatusCode.OK, (await SellAsync(client, seeded, "top_up_cash")).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == seeded.TenantId && a.Action == "credit.adjusted").ToListAsync());

        Assert.Equal(seeded.AdminUserId, row.ActorUserId);
        Assert.Equal(seeded.MemberUserId, row.SubjectUserId);

        var details = JsonDocument.Parse(row.DetailsJson!).RootElement;
        Assert.Equal("AdminTopUp", details.GetProperty("entry_type").GetString());
        Assert.Equal("top_up_cash", details.GetProperty("reason_code").GetString());
        Assert.Equal(0, details.GetProperty("balance_before_minutes").GetInt32());
        Assert.Equal(300, details.GetProperty("balance_after_minutes").GetInt32());
        // P13 §3.7: the sale names the package it sold.
        Assert.Equal(seeded.FiveHours, details.GetProperty("package_id").GetGuid());
        Assert.Equal("5 hours", details.GetProperty("package_name").GetString());
        Assert.Equal(300, details.GetProperty("minutes").GetInt32());
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
            Assert.Equal(HttpStatusCode.OK, (await SellAsync(client, seeded, "top_up_cash")).StatusCode);

            var frames = new List<Crusaders.Mainframe.Api.Services.Realtime.RealtimeMessage>();
            while (channel.Reader.TryRead(out var frame)) frames.Add(frame);

            var named = Assert.Single(frames, f => f.Event == "balance");
            Assert.Contains("\"delta_minutes\":300", named.JsonPayload);
            Assert.Contains("\"reason\":\"admin_top_up\"", named.JsonPayload);
        }
        finally
        {
            bus.Unsubscribe(topic, channel);
        }
    }
}
