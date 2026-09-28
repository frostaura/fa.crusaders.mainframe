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
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What an admin's browser gets back when the club's mail server is down and they approve
/// somebody.
///
/// <para>
/// It used to get <b>HTTP 500</b>, for a member whose row already said <c>Active</c>. The
/// approval commits in <c>MemberApprovalService.ApproveAsync</c> and the welcome email is
/// attempted afterwards; the send was awaited bare, so <c>SmtpException</c> travelled up
/// through the endpoint and out. Two independent agents hit this by accident before one
/// reproduced it deliberately, watching <c>memberships."Status"</c> go 0 → 1 while the caller
/// received a 500 and the console printed "Approval failed." An admin who believes that
/// presses Approve again, and the second press answers 404 because the member is no longer
/// pending.
/// </para>
///
/// <para>
/// This is the HTTP tier of that fix rather than the service tier, because the status code is
/// the part that reached a person: <c>MemberLifecycleTests</c> proves the service does not
/// throw, and this proves nothing between the service and the wire turns the answer back into
/// a failure. It is Postgres-backed because a real commit is the whole premise — the defect is
/// precisely that the row was durable and the answer said otherwise.
/// </para>
/// </summary>
public sealed class AdminMemberNotificationHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminMemberNotificationHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid ApplicantMembershipId);

    /// <summary>An SMTP host that refuses the connection, which is what a dead one does.</summary>
    private sealed class RefusingEmailService : IEmailService
    {
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) =>
            throw new System.Net.Mail.SmtpException(
                System.Net.Mail.SmtpStatusCode.MailboxUnavailable, "Connection refused (test).");
    }

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static WebApplicationFactory<Program> WithMail(TestWebAppFactory factory, IEmailService mail)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton(mail);
        }));

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
            TenantId = tenant.Id, UserId = applicant.Id, FullName = "Ada Lovelace",
            MembershipNumber = $"M-{slug}"[..12], Status = MembershipStatus.PendingApproval,
        };
        db.Memberships.AddRange(
            new Membership
            {
                TenantId = tenant.Id, UserId = admin.Id, FullName = "Desk Admin",
                MembershipNumber = $"A-{slug}"[..12], Status = MembershipStatus.Active,
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

    [SkippableFact]
    public async Task Approving_with_the_mail_server_down_answers_200_and_says_nobody_was_told()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        await using var app = WithMail(factory, new RefusingEmailService());
        var client = AdminClient(app, seeded);

        var response = await client.PostAsync($"/api/v1/admin/members/{seeded.ApplicantMembershipId}/approve", null);

        // The status code is the whole finding. 500 here is what told an admin their approval
        // had failed while the row said otherwise.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.True(body.GetProperty("approved").GetBoolean());
        Assert.False(body.GetProperty("member_notified").GetBoolean());

        // Committed, exactly as it was before the fix — the row was never the problem.
        Assert.Equal(MembershipStatus.Active, await StatusAsync(factory, seeded.ApplicantMembershipId));
    }

    [SkippableFact]
    public async Task Approving_with_a_working_mail_server_says_the_member_was_told()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var mail = new StubEmailService();
        await using var app = WithMail(factory, mail);
        var client = AdminClient(app, seeded);

        var response = await client.PostAsync($"/api/v1/admin/members/{seeded.ApplicantMembershipId}/approve", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        // Discriminating, not always-false: the same field answers true when the mail went.
        Assert.True(body.GetProperty("member_notified").GetBoolean());
        Assert.Contains(mail.Sent, m => m.Subject.Contains("Welcome to"));
    }

    /// <summary>
    /// The admin-issued temporary password, which is reached for precisely when "email
    /// delivery is uncertain" — and which printed <c>email_sent_to</c> whether or not the
    /// send had thrown, so the one screen that exists for a broken mail channel asserted that
    /// the mail channel had worked.
    /// </summary>
    [SkippableFact]
    public async Task A_password_reset_does_not_claim_an_email_it_could_not_send()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        await using var app = WithMail(factory, new RefusingEmailService());
        var client = AdminClient(app, seeded);

        var response = await client.PostAsync($"/api/v1/admin/members/{seeded.ApplicantMembershipId}/reset-password", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("temp_password").GetString()));
        Assert.False(body.GetProperty("member_notified").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("email_sent_to").ValueKind);
    }
}
