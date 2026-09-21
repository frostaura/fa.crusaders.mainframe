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
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The ITN's idempotency, tested the way PayFast actually behaves rather than the way the
/// fixtures assumed it does.
///
/// <para>
/// <b>Every fixture in <see cref="TopUpFlowTests"/> sends a <c>pf_payment_id</c>.</b> That one
/// setup field is why D2-B01 through D2-B04 survived a suite with full coverage of this path:
/// the only idempotency guard on the money-in route is a unique index filtered
/// <c>WHERE "ExternalReference" IS NOT NULL</c>, and <c>PaymentId</c> is
/// <c>Field("pf_payment_id")</c>, which is <b>null when the field is missing</b>. Vary that one
/// field and the guard is simply not there — two deliveries of the same payment both credit.
/// This file varies it.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class TopUpItnIdempotencyTests
{
    private readonly PostgresFixture _pg;

    public TopUpItnIdempotencyTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string Passphrase = "not-a-real-passphrase-test-fixture-only";
    private const string MerchantId = "10000100";
    private const string CallbackPath = "/api/v1/credit/topup/callback";

    private sealed record Seeded(Guid TenantId, string Slug, Guid MemberUserId, string Email);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static string N(decimal v) => v.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static string SettingsJson(decimal maxZar = 1000m) =>
        $$"""
        {
          "credits_per_zar_regular": 1.6,
          "credits_per_zar_league": 2.4,
          "topup_block_zar": 100,
          "topup_max_zar_per_member": {{N(maxZar)}},
          "payfast": {
            "merchant_id": "{{MerchantId}}",
            "merchant_key": "46f0cd694581a",
            "passphrase": "{{Passphrase}}",
            "environment": "test"
          }
        }
        """;

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, string? settingsJson = null, string? slugSeed = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"{slugSeed ?? "itn"}-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "ITN Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson ?? SettingsJson() });

        var email = $"{slug}@test.local";
        var member = new User { TenantId = tenant.Id, Email = email, PasswordHash = "x", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "Naledi Khoza",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, member.Id, email);
    }

    private static HttpClient MemberClient(TestWebAppFactory factory, Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.MemberUserId.ToString()),
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

    /// <summary>
    /// An ITN with the <c>pf_payment_id</c> under the caller's control — present, absent, or a
    /// value shared with another club.
    /// </summary>
    private static HttpContent Itn(string mPaymentId, string gross, string? pfPaymentId, string status = "COMPLETE")
    {
        var fields = new List<KeyValuePair<string, string?>>
        {
            new("m_payment_id", mPaymentId),
        };
        if (pfPaymentId is not null) fields.Add(new("pf_payment_id", pfPaymentId));
        fields.Add(new("payment_status", status));
        fields.Add(new("item_name", "Crusaders credits top-up"));
        fields.Add(new("amount_gross", gross));
        fields.Add(new("amount_fee", "-2.30"));
        fields.Add(new("amount_net", "97.70"));
        fields.Add(new("merchant_id", MerchantId));

        var body = string.Join("&", fields
            .Select(f => $"{f.Key}={PayFastSignature.UrlEncode(f.Value!)}")
            .Append($"signature={PayFastSignature.Compute(fields, Passphrase)}"));

        return new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
    }

    private static async Task<string> RegisterAsync(HttpClient client, decimal amountZar)
    {
        var res = await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("checkout_id").GetString()!;
    }

    private static async Task<(decimal Balance, int Rows)> LedgerAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId).ToListAsync();
        return (rows.Sum(r => r.AmountCredits), rows.Count);
    }

    // ---- D2-B01: an ITN with no pf_payment_id --------------------------------

    /// <summary>
    /// <b>D2-B01.</b> <c>ExternalReference: interp.PaymentId</c>, and <c>PaymentId</c> is
    /// <c>Field("pf_payment_id")</c> — null when the field is missing. A null reference is
    /// excluded by the index filter, so the ONE idempotency guard on the money-in path
    /// disappears, and the <c>Status == Completed</c> short-circuit does not help because two
    /// deliveries racing each other both read <c>Pending</c>.
    ///
    /// <para>
    /// Answered <c>400 payment_id_missing</c> rather than credited-once: a notification with no
    /// payment id cannot be made idempotent by anything, and PayFast retrying into a 400 is a
    /// club that has not been paid rather than a member credited twice. The refusal is visible;
    /// the double credit was not.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task An_ITN_with_no_payment_id_is_refused_rather_than_credited()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var checkoutId = await RegisterAsync(client, 100m);

        var first = await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", pfPaymentId: null));
        Assert.Equal(HttpStatusCode.BadRequest, first.StatusCode);
        Assert.Equal("payment_id_missing",
            (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // The delivery PayFast will make again.
        var second = await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", pfPaymentId: null));
        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);

        var (balance, rows) = await LedgerAsync(factory, seeded);
        Assert.Equal(0, rows);
        Assert.Equal(0m, balance);

        // And the row is still Pending, so a properly-formed retry can still complete it.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var pending = await db.PendingTopups.IgnoreQueryFilters().FirstAsync(p => p.IdempotencyKey == checkoutId);
        Assert.Equal(TopUpStatus.Pending, pending.Status);
    }

    /// <summary>A well-formed retry of the same payment credits exactly once.</summary>
    [SkippableFact]
    public async Task A_retried_ITN_for_one_payment_credits_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var checkoutId = await RegisterAsync(client, 100m);

        for (var attempt = 0; attempt < 3; attempt++)
        {
            var res = await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", "5150001"));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        }

        var (balance, rows) = await LedgerAsync(factory, seeded);
        Assert.Equal(1, rows);
        Assert.Equal(160m, balance);
    }

    /// <summary>
    /// <b>D2-B03.</b> Two deliveries of one payment IN FLIGHT AT ONCE. The read-then-write
    /// short-circuit loses this race by construction — under READ COMMITTED neither can see the
    /// other's uncommitted row — so the filtered unique index is the only thing that decides it,
    /// and the ITN was the one <c>PostAsync</c> caller with no <c>DbUpdateException</c> catch.
    /// The loser escaped as a 500 and PayFast retried into it.
    /// </summary>
    [SkippableFact]
    public async Task Two_concurrent_deliveries_of_one_payment_credit_once_and_neither_is_a_500()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var checkoutId = await RegisterAsync(client, 100m);

        var both = await Task.WhenAll(
            client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", "5150002")),
            client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", "5150002")));

        Assert.All(both, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));

        var (balance, rows) = await LedgerAsync(factory, seeded);
        Assert.Equal(1, rows);
        Assert.Equal(160m, balance);
    }

    /// <summary>
    /// The duplicate catch, provoked DETERMINISTICALLY rather than by hoping two requests race.
    ///
    /// <para>
    /// Two separate registrations by one member reporting the same <c>pf_payment_id</c>. The
    /// first credits; the second cannot — the reference is taken — and the read-then-write
    /// short-circuit cannot see it, because it keys on the pending row's own status and this is
    /// a different pending row. So the filtered unique index is the only thing that decides it,
    /// which is precisely the shape two concurrent deliveries produce and which the TestServer
    /// will not reliably reproduce by running them at once.
    /// </para>
    ///
    /// <para>
    /// The answer is a 409 naming the collision rather than an idempotent 200: two
    /// registrations are two intents, and quietly marking the second Completed would tell the
    /// member their second R100 had been credited when it had not.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_second_registration_reusing_a_payment_id_is_refused_rather_than_500ing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);

        var firstCheckout = await RegisterAsync(client, 100m);
        var secondCheckout = await RegisterAsync(client, 100m);

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(firstCheckout, "100.00", "5150030"))).StatusCode);

        var collided = await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(secondCheckout, "100.00", "5150030"));

        // Not a 500. That is the whole assertion: the ITN was the one PostAsync caller in the
        // tree with no DbUpdateException catch, so this escaped as an unhandled 500 and PayFast
        // retried into it until a retry happened to find the row Completed.
        Assert.NotEqual(HttpStatusCode.InternalServerError, collided.StatusCode);

        // 409 rather than an idempotent 200, because this is NOT a retry: it is a second
        // registration whose payment id is already spent, and it has not been paid for. Telling
        // the member it was credited would be the more comfortable lie.
        Assert.Equal(HttpStatusCode.Conflict, collided.StatusCode);
        Assert.Equal("payment_id_conflict",
            (await collided.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // And the member was credited exactly once for the one payment that exists.
        var (balance, rows) = await LedgerAsync(factory, seeded);
        Assert.Equal(1, rows);
        Assert.Equal(160m, balance);
    }

    // ---- D2-B02: the reference is not tenant-namespaced -----------------------

    /// <summary>
    /// <b>D2-B02.</b> The unique index on <c>ExternalReference</c> carries no
    /// <c>TenantId</c> — <c>WalletEndpoints.IdempotencyReference</c> prefixes adjustments by
    /// hand precisely to avoid this, and the top-up path did not. Two clubs on one PayFast
    /// merchant account, or a sandbox with small repeating ids, collide: the second club's
    /// post raises, and with D2-B03's missing catch that is a 500, a <c>PendingTopup</c> stuck
    /// at <c>Pending</c>, and <b>a member never credited for money PayFast took</b>.
    /// </summary>
    [SkippableFact]
    public async Task Two_clubs_sharing_a_payment_id_are_both_credited()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var clubA = await SeedAsync(factory, slugSeed: "a");
        var clubB = await SeedAsync(factory, slugSeed: "b");

        const string sharedPaymentId = "1000001";

        var checkoutA = await RegisterAsync(MemberClient(factory, clubA), 100m);
        var checkoutB = await RegisterAsync(MemberClient(factory, clubB), 100m);

        var a = await factory.CreateClient().PostAsync(
            $"{CallbackPath}?tenant={clubA.Slug}", Itn(checkoutA, "100.00", sharedPaymentId));
        var b = await factory.CreateClient().PostAsync(
            $"{CallbackPath}?tenant={clubB.Slug}", Itn(checkoutB, "100.00", sharedPaymentId));

        Assert.Equal(HttpStatusCode.OK, a.StatusCode);
        Assert.Equal(HttpStatusCode.OK, b.StatusCode);

        Assert.Equal((160m, 1), await LedgerAsync(factory, clubA));
        Assert.Equal((160m, 1), await LedgerAsync(factory, clubB));
    }

    /// <summary>The reference actually stored carries the tenant, so the two clubs' keys can never meet.</summary>
    [SkippableFact]
    public async Task A_topup_reference_is_namespaced_by_tenant()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var checkoutId = await RegisterAsync(client, 100m);

        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", "5150003"))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var entry = await db.LedgerEntries.IgnoreQueryFilters()
            .FirstAsync(l => l.TenantId == seeded.TenantId && l.Type == LedgerEntryType.TopUp);

        Assert.Equal($"topup:{seeded.TenantId:N}:5150003", entry.ExternalReference);
    }

    // ---- D2-B04: Failed is terminal -------------------------------------------

    /// <summary>
    /// <b>D2-B04.</b> The short-circuit covered <c>Completed</c> only. The amount-mismatch path
    /// sets <c>Failed</c> and <b>keeps the original AmountZar and ConversionRate</b>, so a later
    /// signed COMPLETE for the same <c>m_payment_id</c> fell straight through and credited at
    /// the originally-quoted figure — for a top-up the member had already been emailed about as
    /// failed. Combined with D2-B01 it was repeatable.
    ///
    /// <para>
    /// Every terminal state is now terminal. <c>200</c>, not an error: PayFast retries until it
    /// is acknowledged, and a club that answers 4xx for ever gets retried for ever.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData("FAILED")]
    [InlineData("CANCELLED")]
    public async Task A_terminal_topup_is_not_resurrected_by_a_later_complete(string terminalStatus)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var checkoutId = await RegisterAsync(client, 100m);

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", "5150004", terminalStatus))).StatusCode);

        var resurrect = await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", "5150005"));

        Assert.Equal(HttpStatusCode.OK, resurrect.StatusCode);
        var body = await resurrect.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(body.GetProperty("ok").GetBoolean());
        Assert.Equal("already_settled", body.GetProperty("reason").GetString());

        var (balance, rows) = await LedgerAsync(factory, seeded);
        Assert.Equal(0, rows);
        Assert.Equal(0m, balance);
    }

    /// <summary>
    /// The mismatch half of the same bug, which is the one that reached a member: R1 reported
    /// against a R1000 registration fails the row, and a later COMPLETE then credited 1600
    /// credits for one rand.
    /// </summary>
    [SkippableFact]
    public async Task A_top_up_failed_for_an_amount_mismatch_cannot_later_be_completed()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var checkoutId = await RegisterAsync(client, 1000m);

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "1.00", "5150006"))).StatusCode);

        var later = await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "1000.00", "5150007"));
        Assert.Equal(HttpStatusCode.OK, later.StatusCode);

        var (balance, rows) = await LedgerAsync(factory, seeded);
        Assert.Equal(0, rows);
        Assert.Equal(0m, balance);
    }

    // ---- D2-B05: the cap is per MEMBER, not per transaction --------------------

    /// <summary>
    /// <b>D2-B05.</b> <c>topup_max_zar_per_member</c> compared one <c>amountZar</c> against the
    /// setting and summed nothing, so blueprint A.3's "R1000 per member" ceiling was a ceiling
    /// on a single transaction and a member could register ten of them. The key's own NAME says
    /// per member.
    ///
    /// <para>
    /// Counted over <b>completed</b> top-ups plus the ones still in flight, because a member
    /// with four pending R1000 registrations open in four tabs has not paid yet but is about to;
    /// counting only settled money is the same hole one round narrower.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_per_member_topup_cap_counts_what_the_member_has_already_topped_up()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, SettingsJson(maxZar: 300m));
        var client = MemberClient(factory, seeded);

        // Two registrations, settled, take the member to R200 of a R300 ceiling.
        foreach (var payment in new[] { "5150010", "5150011" })
        {
            var checkoutId = await RegisterAsync(client, 100m);
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(
                $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", payment))).StatusCode);
        }

        // R100 more is still inside it.
        var inside = await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 100m });
        Assert.Equal(HttpStatusCode.OK, inside.StatusCode);

        // And the next one is not — with the figures the sentence needs in the body.
        var over = await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 100m });
        Assert.Equal(HttpStatusCode.BadRequest, over.StatusCode);

        var body = await over.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("amount_exceeds_member_cap", body.GetProperty("error").GetString());
        Assert.Equal(300m, body.GetProperty("max_zar").GetDecimal());
        Assert.Equal(300m, body.GetProperty("already_zar").GetDecimal());
        Assert.Equal(0m, body.GetProperty("remaining_zar").GetDecimal());
    }

    /// <summary>
    /// A failed or cancelled registration is not money the member topped up, so it must not
    /// consume their ceiling. Varying this one field is the difference between a cap and a
    /// member locked out of their own account by a declined card.
    /// </summary>
    [SkippableFact]
    public async Task A_failed_topup_does_not_consume_the_members_ceiling()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, SettingsJson(maxZar: 100m));
        var client = MemberClient(factory, seeded);

        var checkoutId = await RegisterAsync(client, 100m);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "100.00", "5150020", "FAILED"))).StatusCode);

        // The card was declined; the member may try again.
        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 100m })).StatusCode);
    }

    /// <summary>
    /// An admin is exempt from the per-transaction block rule already, and stays exempt from
    /// the per-member ceiling for the same stated reason: the admin route is unlimited by
    /// blueprint A.3, and this endpoint is the member-facing PayFast flow.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_is_not_bound_by_the_per_member_ceiling()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, SettingsJson(maxZar: 100m));

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var user = await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == seeded.MemberUserId);
            user.IsAdmin = true;
            await db.SaveChangesAsync();
        }

        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, seeded.MemberUserId.ToString()),
                new Claim("tenant_id", seeded.TenantId.ToString()),
                new Claim("tenant_slug", seeded.Slug),
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

        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 5000m })).StatusCode);
    }
}
