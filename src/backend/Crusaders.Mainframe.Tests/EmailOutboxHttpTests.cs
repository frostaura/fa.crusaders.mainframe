using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The email outbox against a real database: an approval is not held by a hung mail server, and
/// two senders claiming at once send every message exactly once.
///
/// <para>
/// The first is the defect that started it. Approving a member awaited the welcome email's SMTP
/// round trip inside the request, so a mail server that stopped answering held the admin's button
/// for the transport's whole fifteen-second timeout (and for a hung connection, longer). The
/// request now writes a row and returns; this proves it by giving the host a transport that never
/// answers.
/// </para>
/// </summary>
public sealed class EmailOutboxHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public EmailOutboxHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid ApplicantMembershipId);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"mail-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Mail Outage Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = "{}" });

        var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var applicant = new User { TenantId = tenant.Id, Email = $"applicant-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, applicant);

        var applicantMembership = new Membership
        {
            TenantId = tenant.Id,
            UserId = applicant.Id,
            FullName = "Ada Lovelace",
            MembershipNumber = $"M-{slug}"[..12],
            Status = MembershipStatus.PendingApproval,
        };
        db.Memberships.AddRange(
            new Membership
            {
                TenantId = tenant.Id,
                UserId = admin.Id,
                FullName = "Desk Admin",
                MembershipNumber = $"A-{slug}"[..12],
                Status = MembershipStatus.Active,
            },
            applicantMembership);

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id, applicantMembership.Id);
    }

    private static HttpClient AdminClient(WebApplicationFactory<Program> factory, Seeded s)
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

    private static async Task<MembershipStatus> StatusAsync(TestWebAppFactory factory, Guid membershipId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return (await db.Memberships.IgnoreQueryFilters().AsNoTracking().FirstAsync(m => m.Id == membershipId)).Status;
    }

    /// <summary>A mail server that accepted the connection and never says another word.</summary>
    private sealed class HungTransport : IEmailTransport
    {
        private int _calls;
        public int Calls => Volatile.Read(ref _calls);

        public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
        {
            Interlocked.Increment(ref _calls);
            await Task.Delay(Timeout.Infinite, ct);
        }
    }

    /// <summary>A mail server slow enough that concurrent senders overlap.</summary>
    private sealed class SlowTransport : IEmailTransport
    {
        public System.Collections.Concurrent.ConcurrentBag<EmailMessage> Sent { get; } = [];

        public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
        {
            await Task.Delay(30, ct);
            Sent.Add(message);
        }
    }

    private static WebApplicationFactory<Program> WithTransport(TestWebAppFactory factory, IEmailTransport transport)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailTransport>();
            s.AddSingleton(transport);
        }));

    [SkippableFact]
    public async Task Approving_a_member_does_not_wait_for_a_mail_server_that_never_answers()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var hung = new HungTransport();
        await using var app = WithTransport(factory, hung);
        var client = AdminClient(app, seeded);

        // Warm the host first: the shared host's first request pays JIT and pipeline start-up, which
        // is not what this measures and made it flaky on a loaded runner.
        await client.GetAsync("/healthz");

        var clock = System.Diagnostics.Stopwatch.StartNew();
        var response = await client.PostAsync($"/api/v1/admin/members/{seeded.ApplicantMembershipId}/approve", null);
        clock.Stop();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.True(body.GetProperty("approved").GetBoolean());
        Assert.True(body.GetProperty("member_email_queued").GetBoolean());

        // The old path awaited SMTP here: 15 s at the transport's own timeout, unbounded when the
        // connection hangs. Anything near the transport's timeout means a mail server is back on the request.
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), $"approval took {clock.Elapsed.TotalMilliseconds:F0} ms");
        Assert.Equal(0, hung.Calls);

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var queued = await db.EmailOutbox.AsNoTracking().SingleAsync(m => m.ToAddress == $"applicant-{seeded.Slug}@test.local");
        Assert.Equal(EmailOutboxState.Pending, queued.State);
        Assert.Equal(seeded.TenantId, queued.TenantId);
        Assert.Contains("Welcome to", queued.Subject);
    }

    [SkippableFact]
    public async Task Senders_running_at_once_send_every_queued_message_exactly_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        await SeedAsync(factory); // migrates the database
        var transport = new SlowTransport();
        await using var app = WithTransport(factory, transport);

        var tag = Guid.NewGuid().ToString("N")[..8];
        var now = DateTimeOffset.UtcNow.AddSeconds(-1);
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            for (var i = 0; i < 60; i++)
            {
                db.EmailOutbox.Add(new EmailOutboxMessage
                {
                    ToAddress = $"{tag}-{i}@outbox.review.test",
                    Subject = $"n{i}",
                    CreatedAt = now,
                    DueAt = now,
                    PayloadJson = System.Text.Json.JsonSerializer.Serialize(
                        new EmailMessage($"{tag}-{i}@outbox.review.test", $"n{i}", "<p>x</p>"), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)),
                });
            }
            await db.SaveChangesAsync();
        }

        var dispatcher = app.Services.GetRequiredService<EmailOutboxDispatcher>();
        var passes = Enumerable.Range(0, 4).Select(_ => Task.Run(async () =>
        {
            while (await dispatcher.DeliverDueAsync(DateTimeOffset.UtcNow, default) > 0) { }
        })).ToArray();
        await Task.WhenAll(passes);

        var mine = transport.Sent.Where(m => m.To.StartsWith(tag, StringComparison.Ordinal)).ToList();
        Assert.Equal(60, mine.Count);
        Assert.Equal(60, mine.Select(m => m.To).Distinct().Count());

        using var check = app.Services.CreateScope();
        var rows = await check.ServiceProvider.GetRequiredService<MainframeDbContext>().EmailOutbox.AsNoTracking()
            .Where(m => m.ToAddress.StartsWith(tag)).ToListAsync();
        Assert.All(rows, r => { Assert.Equal(EmailOutboxState.Sent, r.State); Assert.Equal(1, r.Attempts); });
    }
}
