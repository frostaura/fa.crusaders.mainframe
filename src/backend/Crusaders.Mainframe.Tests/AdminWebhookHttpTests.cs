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
/// The admin webhook surface over real HTTP — specifically the <b>wire casing</b> of the
/// delivery log.
///
/// <para>
/// Every other admin projection in this API names its members explicitly, in snake_case.
/// The deliveries endpoint used C# shorthand (<c>new { d.Id, d.EventType, … }</c>), which
/// takes the serializer's camelCase policy instead — so it answered <c>createdAt</c> and
/// <c>latencyMs</c> while the typed client read <c>CreatedAt</c> and <c>LatencyMs</c>. Every
/// cell rendered "Invalid Date" and "undefinedms", the row key was <c>undefined</c> for every
/// row, and React logged a duplicate-key warning on each render. The data was always correct;
/// only the names disagreed — and this is the one screen that tells an admin whether webhooks
/// are being delivered at all.
/// </para>
///
/// <para>
/// A test on the JSON key names rather than on deserialised values, because a DTO written to
/// match the wrong casing would deserialise a wrongly-cased body perfectly happily. The names
/// are the contract that broke.
/// </para>
/// </summary>
public sealed class AdminWebhookHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminWebhookHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string AdminWebhooksPath = "/api/v1/admin/webhooks/";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId);

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"whk-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Webhook Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });

        var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        db.Users.Add(admin);
        await db.SaveChangesAsync();

        return new Seeded(tenant.Id, slug, admin.Id);
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

    [SkippableFact]
    public async Task The_delivery_log_answers_snake_case_like_every_other_admin_projection()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var created = await client.PostAsJsonAsync(AdminWebhooksPath, new
        {
            urlTemplate = "https://example.com/hook?type={type}",
            eventFilter = "*",
            description = "Casing fixture",
        });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var endpointId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.WebhookDeliveries.Add(new WebhookDelivery
            {
                TenantId = seeded.TenantId,
                EndpointId = endpointId,
                EventId = $"evt_{Guid.NewGuid():N}",
                EventType = "booking.created",
                Url = "https://example.com/hook?type=booking.created",
                RequestBody = "{}",
                ResponseStatus = null,
                LatencyMs = 2,
                Attempt = 3,
                FinalState = "pending",
                ResponseBodyExcerpt = "exception:HttpRequestException",
            });
            await db.SaveChangesAsync();
        }

        var deliveries = await client.GetAsync($"{AdminWebhooksPath}{endpointId}/deliveries");
        Assert.Equal(HttpStatusCode.OK, deliveries.StatusCode);
        var row = JsonDocument.Parse(await deliveries.Content.ReadAsStringAsync()).RootElement.EnumerateArray().Single();

        // The names, not the values — a DTO matching the wrong casing would read a wrongly
        // cased body without complaint.
        var names = row.EnumerateObject().Select(p => p.Name).ToHashSet();
        Assert.Equal(
            new HashSet<string> { "id", "event_type", "url", "response_status", "latency_ms", "attempt", "final_state", "created_at", "response_body_excerpt" },
            names);

        // And they carry what the screen renders, so the fix is not names over an empty row.
        Assert.Equal("booking.created", row.GetProperty("event_type").GetString());
        Assert.Equal(2, row.GetProperty("latency_ms").GetInt32());
        Assert.Equal(3, row.GetProperty("attempt").GetInt32());
        Assert.NotEqual(default, row.GetProperty("created_at").GetDateTimeOffset());
        Assert.NotEqual(Guid.Empty, row.GetProperty("id").GetGuid());
    }

    /// <summary>
    /// A refusal names its reason. The create form showed "Couldn't create endpoint." for a
    /// typo'd scheme, an unparseable URL and a deliberate LAN destination alike; the API told
    /// them apart the whole time and the screen threw the distinction away.
    /// </summary>
    [SkippableTheory]
    [InlineData("http://127.0.0.1:5901/hook", "destination_not_permitted")]
    [InlineData("http://192.168.1.50/hook", "destination_not_permitted")]
    [InlineData("http://169.254.169.254/latest/meta-data/", "destination_not_permitted")]
    [InlineData("ftp://example.com/hook", "scheme_must_be_http_or_https")]
    [InlineData("not-a-url", "url_invalid")]
    public async Task A_refused_destination_carries_a_named_reason(string url, string expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var created = await client.PostAsJsonAsync(AdminWebhooksPath, new { urlTemplate = url, eventFilter = "*" });
        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
        Assert.Equal(expected, (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }
}
