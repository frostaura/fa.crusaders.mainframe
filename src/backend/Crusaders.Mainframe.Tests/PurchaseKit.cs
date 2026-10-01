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
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A club ready to sell minutes (P13 §3.4): PayFast test credentials, the opening shelf
/// (1 hour R120, 5 hours R550, 10 hours R1000), a league group with no discount yet, an admin and
/// two members. Shared by the purchase, ITN and desk test classes so each tests behaviour rather
/// than re-building the fixture.
/// </summary>
internal sealed record PurchaseClub(
    Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId, Guid OtherUserId, string MemberEmail,
    Guid LeagueGroupId, Guid OneHour, Guid FiveHours, Guid TenHours);

internal static class PurchaseKit
{
    public const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    public const string Passphrase = "not-a-real-passphrase-test-fixture-only";
    public const string MerchantId = "10000100";
    public const string CallbackPath = "/api/v1/credit/topup/callback";

    public static string SettingsJson(bool payments = true) => payments
        ? $$"""
          {
            "payfast": {
              "merchant_id": "{{MerchantId}}",
              "merchant_key": "46f0cd694581a",
              "passphrase": "{{Passphrase}}",
              "environment": "test"
            }
          }
          """
        : "{}";

    public static async Task<PurchaseClub> SeedAsync(WebApplicationFactory<Program> factory, string prefix, bool payments = true)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var slug = $"{prefix}-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Crusaders" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = SettingsJson(payments) });

        var ids = new List<Guid>();
        var emails = new List<string>();
        foreach (var (name, admin) in new[] { ("Ada Admin", true), ("Naledi Khoza", false), ("Sipho Dlamini", false) })
        {
            var email = $"{Guid.NewGuid():N}@test.local";
            var user = new User { TenantId = tenant.Id, Email = email, PasswordHash = "x", EmailVerified = true, IsAdmin = admin };
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
            emails.Add(email);
        }

        var league = TestHost.LeagueGroup(tenant.Id);
        db.MemberGroups.Add(league);
        await db.SaveChangesAsync();

        await MinutePackageSeeder.EnsureAsync(db, tenant.Id, ids[0]);
        var shelf = await db.MinutePackages.IgnoreQueryFilters().Where(p => p.TenantId == tenant.Id).ToListAsync();
        Guid Id(int minutes) => shelf.Single(p => p.Minutes == minutes).Id;

        return new PurchaseClub(tenant.Id, slug, ids[0], ids[1], ids[2], emails[1], league.Id, Id(60), Id(300), Id(600));
    }

    public static HttpClient Client(WebApplicationFactory<Program> factory, PurchaseClub club, Guid userId, bool admin = false)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("tenant_id", club.TenantId.ToString()),
            new("tenant_slug", club.Slug),
            new("purpose", "access"),
        };
        if (admin) claims.Add(new Claim(ClaimTypes.Role, "admin"));
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", new JwtSecurityTokenHandler().WriteToken(token));
        return client;
    }

    public static HttpClient Member(WebApplicationFactory<Program> factory, PurchaseClub club) => Client(factory, club, club.MemberUserId);

    public static HttpClient Admin(WebApplicationFactory<Program> factory, PurchaseClub club) => Client(factory, club, club.AdminUserId, admin: true);

    /// <summary>An ITN as PayFast composes it: fields in posted order, signature last.</summary>
    public static HttpContent Itn(string mPaymentId, string gross, string? pfPaymentId = null, string status = "COMPLETE")
    {
        var fields = new List<KeyValuePair<string, string?>>
        {
            new("m_payment_id", mPaymentId),
            new("pf_payment_id", pfPaymentId ?? Random.Shared.Next(1_000_000, 9_999_999).ToString()),
            new("payment_status", status),
            new("item_name", "Crusaders - 5 hours (5 h)"),
            new("amount_gross", gross),
            new("amount_fee", "-2.30"),
            new("amount_net", "97.70"),
            new("merchant_id", MerchantId),
        };
        if (pfPaymentId == "") fields.RemoveAll(f => f.Key == "pf_payment_id");

        var body = string.Join("&", fields
            .Select(f => $"{f.Key}={PayFastSignature.UrlEncode(f.Value!)}")
            .Append($"signature={PayFastSignature.Compute(fields, Passphrase)}"));
        return new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
    }

    public static Task<HttpResponseMessage> PostItnAsync(
        WebApplicationFactory<Program> factory, PurchaseClub club, string mPaymentId, string gross, string? pfPaymentId = null, string status = "COMPLETE")
        => factory.CreateClient().PostAsync($"{CallbackPath}?tenant={club.Slug}", Itn(mPaymentId, gross, pfPaymentId, status));

    public static async Task<JsonElement> ShelfAsync(HttpClient client)
        => await client.GetFromJsonAsync<JsonElement>("/api/v1/minutes/packages");

    /// <summary>The live <c>price_zar</c> of a package on this client's shelf.</summary>
    public static async Task<decimal> PriceAsync(HttpClient client, Guid packageId)
    {
        var shelf = await ShelfAsync(client);
        return shelf.GetProperty("packages").EnumerateArray()
            .Single(p => p.GetProperty("id").GetGuid() == packageId).GetProperty("price_zar").GetDecimal();
    }

    /// <summary>Buys a package at the price the shelf shows now; asserts 200.</summary>
    public static async Task<Purchase> BuyAsync(HttpClient client, Guid packageId)
    {
        var quoted = await PriceAsync(client, packageId);
        var res = await client.PostAsJsonAsync("/api/v1/minutes/purchase", new { packageId, quotedPriceZar = quoted });
        Assert.True(res.StatusCode == HttpStatusCode.OK, await res.Content.ReadAsStringAsync());
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        return new Purchase(
            body.GetProperty("purchase_id").GetGuid(), body.GetProperty("checkout_id").GetString()!,
            body.GetProperty("amount_zar").GetDecimal(), body);
    }

    public static string Gross(decimal zar) => zar.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);

    public static async Task<PendingTopup> RowAsync(WebApplicationFactory<Program> factory, Guid id)
        => await ReadAsync(factory, db => db.PendingTopups.IgnoreQueryFilters().AsNoTracking().SingleAsync(p => p.Id == id));

    public static async Task<List<LedgerEntry>> LedgerAsync(WebApplicationFactory<Program> factory, PurchaseClub club, Guid userId)
        => await ReadAsync(factory, db => db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == club.TenantId && l.UserId == userId).ToListAsync());

    public static async Task BackdateAsync(WebApplicationFactory<Program> factory, Guid id, TimeSpan by)
        => await WriteAsync(factory, async db =>
        {
            var row = await db.PendingTopups.IgnoreQueryFilters().SingleAsync(p => p.Id == id);
            row.CreatedAt -= by;
        });

    /// <summary>Puts the member in a group; a new one with the given discount when no id is given.</summary>
    public static async Task<Guid> JoinAsync(
        WebApplicationFactory<Program> factory, PurchaseClub club, Guid userId, Guid? groupId = null, string? name = null,
        int? discountBps = null, MemberGroupStatus status = MemberGroupStatus.Active)
    {
        var id = groupId ?? Guid.NewGuid();
        await WriteAsync(factory, db =>
        {
            if (groupId is null)
            {
                db.MemberGroups.Add(new MemberGroup
                {
                    Id = id, TenantId = club.TenantId, Name = name!, PackageDiscountBps = discountBps, Status = status, SortOrder = 3,
                });
            }
            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = club.TenantId, GroupId = id, UserId = userId, AddedByUserId = club.AdminUserId,
            });
            return Task.CompletedTask;
        });
        return id;
    }

    public static Task SetDiscountAsync(WebApplicationFactory<Program> factory, Guid groupId, int? bps)
        => WriteAsync(factory, async db =>
        {
            var group = await db.MemberGroups.IgnoreQueryFilters().SingleAsync(g => g.Id == groupId);
            group.PackageDiscountBps = bps;
        });

    public static async Task<Guid> AddPackageAsync(
        WebApplicationFactory<Program> factory, PurchaseClub club, string name, int minutes, decimal price, Guid? groupId = null)
    {
        var package = new MinutePackage
        {
            TenantId = club.TenantId, Name = name, Minutes = minutes, PriceZar = price, GroupId = groupId,
            SortOrder = 9, CreatedByUserId = club.AdminUserId,
        };
        await WriteAsync(factory, db => { db.MinutePackages.Add(package); return Task.CompletedTask; });
        return package.Id;
    }

    public static Task EditPackageAsync(WebApplicationFactory<Program> factory, Guid packageId, Action<MinutePackage> edit)
        => WriteAsync(factory, async db => edit(await db.MinutePackages.IgnoreQueryFilters().SingleAsync(p => p.Id == packageId)));

    public static async Task<T> ReadAsync<T>(WebApplicationFactory<Program> factory, Func<MainframeDbContext, Task<T>> read)
    {
        using var scope = factory.Services.CreateScope();
        return await read(scope.ServiceProvider.GetRequiredService<MainframeDbContext>());
    }

    public static async Task WriteAsync(WebApplicationFactory<Program> factory, Func<MainframeDbContext, Task> write)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await write(db);
        await db.SaveChangesAsync();
    }
}

/// <summary>A registered purchase: its row, the checkout id PayFast echoes back, and the locked price.</summary>
internal sealed record Purchase(Guid Id, string CheckoutId, decimal AmountZar, JsonElement Body);
