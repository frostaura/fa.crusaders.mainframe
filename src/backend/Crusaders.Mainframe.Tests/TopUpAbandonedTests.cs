using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4, M4-1 (HIGH, live in production): PayFast sends no ITN when a member cancels on
/// its page or abandons it, the row stayed <c>Pending</c>, and <c>Pending</c> counts against the
/// per-member ceiling — so one abandoned R1000 checkout locked a member out of topping up for good.
///
/// <para>
/// Pinned here: the cancel return closes the member's own row (idempotently, never over a
/// completion); a Pending row older than the checkout lifetime stops counting at once; the sweep
/// closes it; and in every case a signed COMPLETE arriving later STILL credits the member, because
/// money moved — only the gateway's own cancel or failure is terminal (D2-B04, tested beside it).
/// </para>
/// </summary>
public sealed class TopUpAbandonedTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string Passphrase = "not-a-real-passphrase-test-fixture-only";
    private const string MerchantId = "10000100";
    private const string CallbackPath = "/api/v1/credit/topup/callback";

    private sealed record Seeded(Guid TenantId, string Slug, Guid MemberUserId, Guid OtherUserId);

    private sealed record Registered(Guid TopUpId, string CheckoutId);

    private static string SettingsJson(decimal maxZar) =>
        $$"""
        {
          "credits_per_zar_regular": 1.6,
          "credits_per_zar_league": 2.4,
          "topup_block_zar": 100,
          "topup_max_zar_per_member": {{maxZar.ToString(System.Globalization.CultureInfo.InvariantCulture)}},
          "payfast": {
            "merchant_id": "{{MerchantId}}",
            "merchant_key": "46f0cd694581a",
            "passphrase": "{{Passphrase}}",
            "environment": "test"
          }
        }
        """;

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, decimal maxZar)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var slug = $"abn-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Abandon Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = SettingsJson(maxZar) });

        var ids = new List<Guid>();
        foreach (var name in new[] { "Naledi Khoza", "Sipho Dlamini" })
        {
            var user = new User { TenantId = tenant.Id, Email = $"{Guid.NewGuid():N}@test.local", PasswordHash = "x", EmailVerified = true };
            db.Users.Add(user);
            db.Memberships.Add(new Membership
            {
                TenantId = tenant.Id,
                UserId = user.Id,
                FullName = name,
                MembershipNumber = Guid.NewGuid().ToString("N")[..12],
                Status = MembershipStatus.Active,
            });
            ids.Add(user.Id);
        }

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, ids[0], ids[1]);
    }

    private static HttpClient Client(TestWebAppFactory factory, Seeded s, Guid userId)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, userId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
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

    private static HttpContent Itn(string mPaymentId, string pfPaymentId, string status = "COMPLETE")
    {
        var fields = new List<KeyValuePair<string, string?>>
        {
            new("m_payment_id", mPaymentId),
            new("pf_payment_id", pfPaymentId),
            new("payment_status", status),
            new("item_name", "Crusaders credits top-up"),
            new("amount_gross", "100.00"),
            new("amount_fee", "-2.30"),
            new("amount_net", "97.70"),
            new("merchant_id", MerchantId),
        };
        var body = string.Join("&", fields
            .Select(f => $"{f.Key}={PayFastSignature.UrlEncode(f.Value!)}")
            .Append($"signature={PayFastSignature.Compute(fields, Passphrase)}"));
        return new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
    }

    private static async Task<Registered> RegisterAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 100m });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        return new Registered(body.GetProperty("topup_id").GetGuid(), body.GetProperty("checkout_id").GetString()!);
    }

    private static async Task<decimal> RemainingAsync(HttpClient client)
    {
        var body = await client.GetFromJsonAsync<JsonElement>("/api/v1/credit/topup/options");
        return body.GetProperty("remaining_zar").GetDecimal();
    }

    private static async Task<JsonElement> CancelReturnAsync(HttpClient client, Guid topUpId, HttpStatusCode expected = HttpStatusCode.OK)
    {
        var res = await client.PostAsync($"/api/v1/credit/topup/{topUpId}/cancel", null);
        Assert.Equal(expected, res.StatusCode);
        return expected == HttpStatusCode.OK ? await res.Content.ReadFromJsonAsync<JsonElement>() : default;
    }

    private static async Task<PendingTopup> RowAsync(TestWebAppFactory factory, Guid id)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.PendingTopups.IgnoreQueryFilters().AsNoTracking().SingleAsync(p => p.Id == id);
    }

    private static async Task<List<LedgerEntry>> LedgerAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId).ToListAsync();
    }

    private static async Task BackdateAsync(TestWebAppFactory factory, Guid id, TimeSpan by)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.PendingTopups.IgnoreQueryFilters().SingleAsync(p => p.Id == id);
        row.CreatedAt -= by;
        await db.SaveChangesAsync();
    }

    [SkippableFact]
    public async Task The_cancel_return_closes_the_members_own_row_and_frees_the_ceiling()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seeded = await SeedAsync(factory, maxZar: 100m);
        var member = Client(factory, seeded, seeded.MemberUserId);

        var reg = await RegisterAsync(member);
        Assert.Equal(0, await RemainingAsync(member));

        // Somebody else's id is a stranger's: 404, and the row is untouched.
        await CancelReturnAsync(Client(factory, seeded, seeded.OtherUserId), reg.TopUpId, HttpStatusCode.NotFound);
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, reg.TopUpId)).Status);

        var body = await CancelReturnAsync(member, reg.TopUpId);
        Assert.Equal("Cancelled", body.GetProperty("status").GetString());
        Assert.Equal("cancelled_at_return", body.GetProperty("failure_code").GetString());

        // Idempotent: the second return answers the same thing.
        var again = await CancelReturnAsync(member, reg.TopUpId);
        Assert.Equal("Cancelled", again.GetProperty("status").GetString());

        Assert.Equal(100, await RemainingAsync(member));
        await RegisterAsync(member);
    }

    /// <summary>
    /// Review round 5, M5-2 (HIGH): back from PayFast twice and the member read "You've topped up
    /// R1000.00" with R0 paid, for up to an hour, with nothing to cancel. The options read now keeps
    /// paid and waiting apart and lists the member's own open checkouts (newest first, with when
    /// each started and until when it holds the limit); cancelling one frees its rand at once, and
    /// the cap refusal says the same split.
    /// </summary>
    [SkippableFact]
    public async Task The_options_list_open_checkouts_and_keep_paid_apart_from_waiting()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seeded = await SeedAsync(factory, maxZar: 300m);
        var member = Client(factory, seeded, seeded.MemberUserId);

        var paid = await RegisterAsync(member);
        var itn = await factory.CreateClient().PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(paid.CheckoutId, "7340101"));
        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        var older = await RegisterAsync(member);
        await BackdateAsync(factory, older.TopUpId, TimeSpan.FromMinutes(5));
        var newer = await RegisterAsync(member);
        await RegisterAsync(Client(factory, seeded, seeded.OtherUserId));

        var options = await member.GetFromJsonAsync<JsonElement>("/api/v1/credit/topup/options");
        Assert.Equal(100m, options.GetProperty("paid_zar").GetDecimal());
        Assert.Equal(200m, options.GetProperty("waiting_zar").GetDecimal());
        Assert.Equal(300m, options.GetProperty("already_zar").GetDecimal());
        Assert.Equal(0m, options.GetProperty("remaining_zar").GetDecimal());
        var open = options.GetProperty("open_checkouts").EnumerateArray().ToList();
        Assert.Equal([newer.TopUpId, older.TopUpId], open.Select(o => o.GetProperty("id").GetGuid()).ToList());
        var started = open[1].GetProperty("created_at").GetDateTimeOffset();
        Assert.Equal((await RowAsync(factory, older.TopUpId)).CreatedAt, started, TimeSpan.FromMilliseconds(1));
        Assert.Equal(started.AddMinutes(60), open[1].GetProperty("counts_until").GetDateTimeOffset());
        Assert.Equal(100m, open[1].GetProperty("amount_zar").GetDecimal());

        var status = await member.GetFromJsonAsync<JsonElement>($"/api/v1/credit/topup/{older.TopUpId}");
        Assert.Equal(started, status.GetProperty("created_at").GetDateTimeOffset());

        // Cancelling one frees its rand at once.
        await CancelReturnAsync(member, older.TopUpId);
        options = await member.GetFromJsonAsync<JsonElement>("/api/v1/credit/topup/options");
        Assert.Equal(100m, options.GetProperty("waiting_zar").GetDecimal());
        Assert.Equal(100m, options.GetProperty("remaining_zar").GetDecimal());
        Assert.Equal([newer.TopUpId], options.GetProperty("open_checkouts").EnumerateArray().Select(o => o.GetProperty("id").GetGuid()).ToList());

        var refused = await member.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 200m });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        var body = await refused.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("amount_exceeds_member_cap", body.GetProperty("error").GetString());
        Assert.Equal(100m, body.GetProperty("paid_zar").GetDecimal());
        Assert.Equal(100m, body.GetProperty("waiting_zar").GetDecimal());
    }

    [SkippableFact]
    public async Task A_complete_arriving_after_the_cancel_return_still_credits_the_member()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seeded = await SeedAsync(factory, maxZar: 1000m);
        var member = Client(factory, seeded, seeded.MemberUserId);

        var reg = await RegisterAsync(member);
        await CancelReturnAsync(member, reg.TopUpId);

        var itn = await factory.CreateClient().PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(reg.CheckoutId, "7340001"));
        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        Assert.True((await itn.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ok").GetBoolean());

        var row = await RowAsync(factory, reg.TopUpId);
        Assert.Equal(TopUpStatus.Completed, row.Status);
        Assert.Null(row.FailureReason);
        Assert.Equal(160, Assert.Single(await LedgerAsync(factory, seeded)).AmountMinutes);

        // And a cancel return after the completion does not undo it.
        var late = await CancelReturnAsync(member, reg.TopUpId);
        Assert.Equal("Completed", late.GetProperty("status").GetString());
    }

    [SkippableFact]
    public async Task An_abandoned_checkout_stops_counting_after_its_lifetime_and_the_sweep_closes_it()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seeded = await SeedAsync(factory, maxZar: 100m);
        var member = Client(factory, seeded, seeded.MemberUserId);

        var abandoned = await RegisterAsync(member);
        await BackdateAsync(factory, abandoned.TopUpId, TimeSpan.FromMinutes(59));
        Assert.Equal(0, await RemainingAsync(member));

        // Past the lifetime it stops counting at once — before any sweep has run.
        await BackdateAsync(factory, abandoned.TopUpId, TimeSpan.FromMinutes(2));
        Assert.Equal(100, await RemainingAsync(member));
        var fresh = await RegisterAsync(member);

        // The sweep closes the old row, not the fresh one, and a second pass finds nothing.
        var worker = factory.Services.GetRequiredService<TopUpExpiryWorker>();
        Assert.True(await worker.TickAsync(DateTimeOffset.UtcNow, CancellationToken.None) >= 1);
        var closed = await RowAsync(factory, abandoned.TopUpId);
        Assert.Equal(TopUpStatus.Cancelled, closed.Status);
        Assert.Equal("expired", closed.FailureReason);
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, fresh.TopUpId)).Status);
        var status = await member.GetFromJsonAsync<JsonElement>($"/api/v1/credit/topup/{abandoned.TopUpId}");
        Assert.Equal("Cancelled", status.GetProperty("status").GetString());
        Assert.Equal("expired", status.GetProperty("failure_code").GetString());

        // Money that moved after all is still credited.
        var itn = await factory.CreateClient().PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(abandoned.CheckoutId, "7340002"));
        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        Assert.Equal(TopUpStatus.Completed, (await RowAsync(factory, abandoned.TopUpId)).Status);
        Assert.Single(await LedgerAsync(factory, seeded));
    }

    /// <summary>The gateway's own cancel stays terminal (D2-B04) — only OUR closings reopen.</summary>
    [SkippableFact]
    public async Task A_gateway_cancel_after_the_cancel_return_is_terminal()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seeded = await SeedAsync(factory, maxZar: 1000m);
        var member = Client(factory, seeded, seeded.MemberUserId);

        var reg = await RegisterAsync(member);
        await CancelReturnAsync(member, reg.TopUpId);
        var gatewayCancel = await factory.CreateClient().PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(reg.CheckoutId, "7340003", "CANCELLED"));
        Assert.Equal(HttpStatusCode.OK, gatewayCancel.StatusCode);
        Assert.Equal("cancelled", (await RowAsync(factory, reg.TopUpId)).FailureReason);

        var resurrect = await factory.CreateClient().PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(reg.CheckoutId, "7340004"));
        Assert.Equal("already_settled", (await resurrect.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason").GetString());
        Assert.Empty(await LedgerAsync(factory, seeded));
    }

    /// <summary>
    /// A cancel return racing the COMPLETE: whichever lands first, the member ends credited exactly
    /// once and the row reads Completed.
    /// </summary>
    [SkippableFact]
    public async Task A_cancel_return_racing_the_complete_always_ends_credited_once()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seeded = await SeedAsync(factory, maxZar: 1000m);
        var member = Client(factory, seeded, seeded.MemberUserId);
        var gateway = factory.CreateClient();

        for (var i = 0; i < 8; i++)
        {
            var reg = await RegisterAsync(member);
            var cancel = member.PostAsync($"/api/v1/credit/topup/{reg.TopUpId}/cancel", null);
            var itn = gateway.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(reg.CheckoutId, $"73401{i:00}"));
            await Task.WhenAll(cancel, itn);
            Assert.Equal(HttpStatusCode.OK, (await cancel).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await itn).StatusCode);

            var row = await RowAsync(factory, reg.TopUpId);
            Assert.Equal(TopUpStatus.Completed, row.Status);
            Assert.Null(row.FailureReason);
        }

        Assert.Equal(8, (await LedgerAsync(factory, seeded)).Count);
    }

    /// <summary>
    /// Registrations sent together could each read the same remaining rand and all fit: the ceiling
    /// is now read and the row written under the member's lock.
    /// </summary>
    [SkippableFact]
    public async Task Registrations_sent_together_cannot_overrun_the_ceiling()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seeded = await SeedAsync(factory, maxZar: 200m);
        var member = Client(factory, seeded, seeded.MemberUserId);

        var answers = await Task.WhenAll(Enumerable.Range(0, 8)
            .Select(_ => member.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 100m })));

        Assert.Equal(2, answers.Count(a => a.StatusCode == HttpStatusCode.OK));
        Assert.Equal(0, await RemainingAsync(member));
    }
}
