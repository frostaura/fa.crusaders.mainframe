using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The backend-platform pass (2026-11-13) at the HTTP boundary, on Postgres: a club's status and
/// its own address, the registration and pre-account-takeover holes, the photo upload, passkeys,
/// the desk's PIN, the operator CLI and readiness. Split by theme into nested classes, each its
/// own database (<c>memory/decisions-test-running.md</c>); the helpers live here.
/// </summary>
public abstract class PlatformPassHttpTests
{
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    protected sealed record Club(Guid TenantId, string Slug, Guid AdminId, Guid AdminMembershipId, Guid MemberId, Guid MembershipId, string MemberEmail)
    {
        public string Host => $"{Slug}.crusaders.test";
    }

    /// <summary>A club with one admin and one active member, under a fresh slug.</summary>
    protected static async Task<Club> SeedAsync(WebApplicationFactory<Program> factory, string prefix, string status = TenantStatus.Active, string? publicBaseUrl = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();

        var slug = $"{prefix}{Guid.NewGuid():N}"[..18];
        var tenant = new Tenant { Slug = slug, DisplayName = "Platform Club", Status = status, PublicBaseUrl = publicBaseUrl };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@platform.review.test", PasswordHash = hasher.Hash("AdminPass1!"), EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@platform.review.test", PasswordHash = hasher.Hash("MemberPass1!"), EmailVerified = true };
        db.Users.AddRange(admin, member);
        var adminMembership = new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Club Admin", MembershipNumber = $"A-{slug}", Status = MembershipStatus.Active };
        var memberMembership = new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Ordinary Member", MembershipNumber = $"M-{slug}", Status = MembershipStatus.Active };
        db.Memberships.AddRange(adminMembership, memberMembership);
        await db.SaveChangesAsync();
        return new Club(tenant.Id, slug, admin.Id, adminMembership.Id, member.Id, memberMembership.Id, member.Email);
    }

    protected static string Token(Club club, Guid subject, string? role = null)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subject.ToString()),
            new("tenant_id", club.TenantId.ToString()),
            new("tenant_slug", club.Slug),
            new("purpose", "access"),
        };
        if (role is not null) claims.Add(new Claim(ClaimTypes.Role, role));
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    protected static HttpClient Signed(WebApplicationFactory<Program> factory, Club club, Guid subject, string? role = null)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(club, subject, role));
        return client;
    }

    protected static HttpClient Anonymous(WebApplicationFactory<Program> factory, string host)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = host;
        return client;
    }

    protected static async Task<JsonElement> JsonOf(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        return string.IsNullOrWhiteSpace(text) ? default : JsonDocument.Parse(text).RootElement.Clone();
    }

    protected static async Task<string?> ErrorOf(HttpResponseMessage response)
    {
        var body = await JsonOf(response);
        return body.ValueKind == JsonValueKind.Object && body.TryGetProperty("error", out var e) ? e.GetString() : null;
    }

    protected static Task<T> ReadAsync<T>(WebApplicationFactory<Program> factory, Func<MainframeDbContext, Task<T>> read) =>
        PeopleClub.ReadAsync(factory, read);

    protected static async Task WriteAsync(WebApplicationFactory<Program> factory, Func<MainframeDbContext, Task> write)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await write(db);
        await db.SaveChangesAsync();
    }

    /// <summary>The token at the end of a link of <paramref name="kind"/> in a captured mail.</summary>
    protected static (string Url, string Token) LinkIn(EmailMessage mail, string kind)
    {
        var m = Regex.Match(mail.HtmlBody, $"(https?://[^\"'<>\\s]+)/{kind}/([A-Za-z0-9_\\-]+)");
        Assert.True(m.Success, $"no /{kind}/ link in '{mail.Subject}'");
        return (m.Groups[1].Value, m.Groups[2].Value);
    }

    protected static async Task<string> AddTokenAsync(WebApplicationFactory<Program> factory, Club club, Guid userId, TokenKind kind, TimeSpan life)
    {
        var plain = TokenHashing.Generate();
        await WriteAsync(factory, db =>
        {
            db.AuthTokens.Add(new AuthToken
            {
                TenantId = club.TenantId, UserId = userId, Kind = kind, TokenHash = TokenHashing.Hash(plain), ExpiresAt = DateTimeOffset.UtcNow.Add(life),
            });
            return Task.CompletedTask;
        });
        return plain;
    }

    // =================================================================================== tenancy

    /// <summary>BP-07 (Tenant.Status was read by nothing) and BP-17 (whoami had no club).</summary>
    public sealed class Tenancy(PostgresFixture pg) : PlatformPassHttpTests, IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// A suspended club is closed to its members and its admins on every tenant-scoped route —
        /// and nobody else's club notices. Varied over the caller: anonymous, member, admin.
        /// </summary>
        [SkippableFact]
        public async Task A_suspended_club_is_closed_to_everybody_in_it_and_only_to_them()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var factory = pg.SharedHost;
            var closed = await SeedAsync(factory, "susp", TenantStatus.Suspended);
            var open = await SeedAsync(factory, "open");

            foreach (var client in new[] { Signed(factory, closed, closed.MemberId), Signed(factory, closed, closed.AdminId, "admin") })
            {
                using var me = await client.GetAsync("/api/v1/me/profile");
                Assert.Equal(HttpStatusCode.Forbidden, me.StatusCode);
                Assert.Equal("club_suspended", await ErrorOf(me));
            }

            using var login = await Anonymous(factory, closed.Host).PostAsJsonAsync("/api/v1/auth/login", new { email = closed.MemberEmail, password = "MemberPass1!" });
            Assert.Equal("club_suspended", await ErrorOf(login));

            using var other = await Signed(factory, open, open.MemberId).GetAsync("/api/v1/me/profile");
            Assert.Equal(HttpStatusCode.OK, other.StatusCode);
        }

        /// <summary>Onboarding is open; any status this build does not know is closed (fail closed).</summary>
        [SkippableTheory]
        [InlineData(TenantStatus.Onboarding, HttpStatusCode.OK)]
        [InlineData(TenantStatus.Active, HttpStatusCode.OK)]
        [InlineData("archived", HttpStatusCode.Forbidden)]
        [InlineData("", HttpStatusCode.Forbidden)]
        public async Task A_status_this_build_does_not_know_is_closed(string status, HttpStatusCode expected)
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "stat", status);
            using var response = await Signed(pg.SharedHost, club, club.MemberId).GetAsync("/api/v1/me/profile");
            Assert.Equal(expected, response.StatusCode);
        }

        [SkippableFact]
        public async Task Whoami_names_the_club_the_token_names_and_none_for_a_stranger()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "who");

            var signed = await JsonOf(await Signed(pg.SharedHost, club, club.AdminId, "admin").GetAsync("/api/v1/whoami"));
            Assert.Equal(club.Slug, signed.GetProperty("tenant_slug").GetString());
            Assert.Equal(club.TenantId, signed.GetProperty("tenant_id").GetGuid());

            var anonymous = await JsonOf(await pg.SharedHost.CreateClient().GetAsync("/api/v1/whoami"));
            Assert.Equal(JsonValueKind.Null, anonymous.GetProperty("tenant_slug").ValueKind);
            Assert.Equal(JsonValueKind.Null, anonymous.GetProperty("tenant_id").ValueKind);
        }

        /// <summary>The member-webhook route is gone (BP-08): nothing a member can register.</summary>
        [SkippableFact]
        public async Task A_member_cannot_register_a_webhook_any_more()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "hook");
            using var response = await Signed(pg.SharedHost, club, club.MemberId).PostAsJsonAsync("/api/v1/webhooks/", new { urlTemplate = "https://hooks.example.com/x" });
            Assert.True(response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed, $"{(int)response.StatusCode}");
            Assert.False(await ReadAsync(pg.SharedHost, db => db.WebhookEndpoints.IgnoreQueryFilters().AnyAsync(w => w.TenantId == club.TenantId)));
        }

        /// <summary>
        /// BP-18: a session token is refused in <c>?ticket=</c> — the query string is in every log
        /// in front of the API. The header form still opens the stream's ticket route.
        /// </summary>
        [SkippableFact]
        public async Task A_session_token_in_the_ticket_query_is_refused()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "tick");
            using var client = pg.SharedHost.CreateClient();
            using var response = await client.GetAsync($"/api/v1/wallet/stream?ticket={Uri.EscapeDataString(Token(club, club.MemberId))}", HttpCompletionOption.ResponseHeadersRead);
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);

            using var minted = await Signed(pg.SharedHost, club, club.MemberId).PostAsync("/api/v1/wallet/stream-ticket", null);
            Assert.Equal(HttpStatusCode.OK, minted.StatusCode);
        }
    }

    // =================================================================================== club links

    /// <summary>BP-03: every link a club's mail carries is that club's own address.</summary>
    public sealed class Links(PostgresFixture pg) : PlatformPassHttpTests, IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// A second club's verify link lands on the second club, where its token exists — through
        /// the body form of the call (BP-18) — and fails on the deployment's own address, which is
        /// where every club's link used to point.
        /// </summary>
        [SkippableFact]
        public async Task A_second_clubs_verify_link_is_its_own_and_works_there()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var mail = new CapturingMail();
            await using var app = CapturingMail.On(pg.SharedHost, mail);
            var club = await SeedAsync(app, "link");
            var email = $"n-{Guid.NewGuid():N}@platform.review.test";

            Assert.Equal(HttpStatusCode.OK, (await TestPhotos.RegisterAsync(Anonymous(app, club.Host), email, $"N-{Guid.NewGuid():N}"[..12])).StatusCode);
            var (url, token) = LinkIn(Assert.Single(mail.Sent, m => m.To == email), "verify-email");
            Assert.Equal($"http://{club.Slug}.localhost:8088", url);

            using var elsewhere = await Anonymous(app, "localhost").PostAsJsonAsync("/api/v1/auth/verify-email", new { token });
            Assert.NotEqual(HttpStatusCode.OK, elsewhere.StatusCode);

            using var home = await Anonymous(app, new Uri(url).Authority).PostAsJsonAsync("/api/v1/auth/verify-email", new { token });
            Assert.Equal(HttpStatusCode.OK, home.StatusCode);
            Assert.True(await ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.Email == email).Select(u => u.EmailVerified).SingleAsync()));
        }

        /// <summary>An operator-set address wins, for the reset and the welcome links alike.</summary>
        [SkippableFact]
        public async Task A_club_with_its_own_address_gets_it_on_reset_and_welcome_links()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var mail = new CapturingMail();
            await using var app = CapturingMail.On(pg.SharedHost, mail);
            var prefix = "own";
            var club = await SeedAsync(app, prefix);
            var address = $"https://{club.Slug}.bookings.example";
            await WriteAsync(app, async db => (await db.Tenants.SingleAsync(t => t.Id == club.TenantId)).PublicBaseUrl = address);

            using (var forgot = await Anonymous(app, club.Host).PostAsJsonAsync("/api/v1/auth/forgot-password", new { email = club.MemberEmail }))
            {
                Assert.Equal(HttpStatusCode.OK, forgot.StatusCode);
            }

            Assert.Equal(address, LinkIn(Assert.Single(mail.Sent, m => m.To == club.MemberEmail), "reset-password").Url);

            // An applicant who confirmed their address, approved: the welcome link is the club's too.
            var applicant = new User { TenantId = club.TenantId, Email = $"w-{Guid.NewGuid():N}@platform.review.test", PasswordHash = "x", EmailVerified = true };
            var membership = new Membership { TenantId = club.TenantId, UserId = applicant.Id, FullName = "Welcome Me", MembershipNumber = $"W-{Guid.NewGuid():N}"[..12], Status = MembershipStatus.PendingApproval };
            await WriteAsync(app, db => { db.Users.Add(applicant); db.Memberships.Add(membership); return Task.CompletedTask; });
            using (var approve = await Signed(app, club, club.AdminId, "admin").PostAsync($"/api/v1/admin/members/{membership.Id}/approve", null))
            {
                Assert.Equal(HttpStatusCode.OK, approve.StatusCode);
            }

            Assert.Equal(address, LinkIn(Assert.Single(mail.Sent, m => m.To == applicant.Email), "welcome").Url);
        }
    }

    // =================================================================================== registration

    /// <summary>BP-06, BA-13 (the photo), BP-14, BM-15 (what the screen says), BP-02, BP-12 (takeover).</summary>
    public sealed class Registration(PostgresFixture pg) : PlatformPassHttpTests, IClassFixture<PostgresFixture>
    {
        private async Task<HttpResponseMessage> ApplyAsync(WebApplicationFactory<Program> app, Club club, string? photoUrl, string? email = null) =>
            await Anonymous(app, club.Host).PostAsJsonAsync("/api/v1/auth/register", new
            {
                email = email ?? $"p-{Guid.NewGuid():N}@platform.review.test", password = "Pass1234!", fullName = "Photo Probe",
                membershipNumber = $"P-{Guid.NewGuid():N}"[..12], photoUrl,
            });

        /// <summary>
        /// The photo is mandatory, issued to THIS club and on disk. Every one of these registered
        /// 200 before: none, an outside tracking pixel, script, an inline image, another club's.
        /// </summary>
        [SkippableTheory]
        [InlineData(null, "photo_required")]
        [InlineData("", "photo_required")]
        [InlineData("https://evil.example/pixel.png", "photo_url_invalid")]
        [InlineData("javascript:alert(1)", "photo_url_invalid")]
        [InlineData("data:image/png;base64,iVBORw0KGgo=", "photo_url_invalid")]
        [InlineData("/uploads/crusaders/photos/0123456789abcdef0123456789abcdef.png", "photo_url_invalid")]
        [InlineData("SELF/0123456789abcdef0123456789abcdef.png", "photo_missing")]
        public async Task An_application_without_a_photo_this_club_issued_is_refused(string? photoUrl, string code)
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "photo");
            var url = photoUrl?.Replace("SELF/", MemberPhotoFiles.PrefixOf(club.Slug), StringComparison.Ordinal);

            using var response = await ApplyAsync(pg.SharedHost, club, url);

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal(code, await ErrorOf(response));
        }

        /// <summary>A face already on another membership is somebody else's face.</summary>
        [SkippableFact]
        public async Task Another_members_photo_cannot_be_reused()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "reuse");
            var photo = await TestPhotos.UploadAsync(Anonymous(pg.SharedHost, club.Host));
            await WriteAsync(pg.SharedHost, async db => (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.Id == club.MembershipId)).PhotoUrl = photo);

            using var response = await ApplyAsync(pg.SharedHost, club, photo);
            Assert.Equal("photo_url_invalid", await ErrorOf(response));
        }

        /// <summary>
        /// The profile edit takes only this club's photos, and replacing one removes the file it
        /// replaces (it used to stay on the volume for ever).
        /// </summary>
        [SkippableFact]
        public async Task The_profile_takes_only_this_clubs_photo_and_drops_the_old_file()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "prof");
            var other = await SeedAsync(pg.SharedHost, "prof");
            var photos = pg.SharedHost.Services.GetRequiredService<MemberPhotoFiles>();
            var foreign = await TestPhotos.UploadAsync(Anonymous(pg.SharedHost, other.Host));
            var first = await TestPhotos.UploadAsync(Anonymous(pg.SharedHost, club.Host));
            var second = await TestPhotos.UploadAsync(Anonymous(pg.SharedHost, club.Host));
            using var member = Signed(pg.SharedHost, club, club.MemberId);

            using (var refused = await member.PutAsJsonAsync("/api/v1/me/profile", new { photoUrl = foreign }))
            {
                Assert.Equal("photo_url_invalid", await ErrorOf(refused));
            }

            Assert.Equal(HttpStatusCode.OK, (await member.PutAsJsonAsync("/api/v1/me/profile", new { photoUrl = first })).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await member.PutAsJsonAsync("/api/v1/me/profile", new { photoUrl = second })).StatusCode);

            Assert.False(photos.Exists(club.Slug, first));
            Assert.True(photos.Exists(club.Slug, second));
            Assert.True(photos.Exists(other.Slug, foreign));
        }

        /// <summary>
        /// BP-02, the whole chain: a stranger registers the victim's address with their own
        /// password; the club cannot approve until the address is confirmed — and confirming it
        /// takes the victim's mailbox. It used to approve, and the stranger's password then signed in.
        /// </summary>
        [SkippableFact]
        public async Task An_unconfirmed_applicant_cannot_be_approved_until_the_mailbox_confirms()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var mail = new CapturingMail();
            await using var app = CapturingMail.On(pg.SharedHost, mail);
            var club = await SeedAsync(app, "take");
            var victim = $"victim-{Guid.NewGuid():N}@platform.review.test";

            Assert.Equal(HttpStatusCode.OK, (await TestPhotos.RegisterAsync(Anonymous(app, club.Host), victim, $"V-{Guid.NewGuid():N}"[..12], "Victim", "Attacker-pw-1")).StatusCode);
            var membershipId = await ReadAsync(app, db => db.Memberships.IgnoreQueryFilters()
                .Where(m => m.TenantId == club.TenantId && m.FullName == "Victim").Select(m => m.Id).SingleAsync());
            using var admin = Signed(app, club, club.AdminId, "admin");

            using (var refused = await admin.PostAsync($"/api/v1/admin/members/{membershipId}/approve", null))
            {
                Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
                Assert.Equal("email_not_verified", await ErrorOf(refused));
            }

            Assert.Equal(MembershipStatus.PendingApproval, await ReadAsync(app, db => db.Memberships.IgnoreQueryFilters().Where(m => m.Id == membershipId).Select(m => m.Status).SingleAsync()));
            Assert.DoesNotContain(mail.Sent, m => m.To == victim && m.HtmlBody.Contains("/welcome/", StringComparison.Ordinal));

            var (url, token) = LinkIn(Assert.Single(mail.Sent, m => m.To == victim), "verify-email");
            Assert.Equal(HttpStatusCode.OK, (await Anonymous(app, new Uri(url).Authority).PostAsync($"/api/v1/auth/verify-email/{token}", null)).StatusCode);
            using var approved = await admin.PostAsync($"/api/v1/admin/members/{membershipId}/approve", null);
            Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
        }

        /// <summary>
        /// Defence in depth behind the approval gate: a welcome link consumed by an account whose
        /// address nobody had confirmed proves the mailbox and retires the password the form chose.
        /// Varied: the same link on a CONFIRMED account keeps its password.
        /// </summary>
        [SkippableTheory]
        [InlineData(false, HttpStatusCode.Unauthorized)]
        [InlineData(true, HttpStatusCode.OK)]
        public async Task A_welcome_link_retires_a_password_nobody_had_proven(bool addressConfirmed, HttpStatusCode passwordAfter)
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "magic");
            await WriteAsync(pg.SharedHost, async db => (await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Id == club.MemberId)).EmailVerified = addressConfirmed);
            var token = await AddTokenAsync(pg.SharedHost, club, club.MemberId, TokenKind.MagicLink, TimeSpan.FromMinutes(15));

            using var consumed = await Anonymous(pg.SharedHost, club.Host).PostAsJsonAsync("/api/v1/auth/magic-link", new { token });
            Assert.Equal(HttpStatusCode.OK, consumed.StatusCode);

            using var password = await Anonymous(pg.SharedHost, club.Host).PostAsJsonAsync("/api/v1/auth/login", new { email = club.MemberEmail, password = "MemberPass1!" });
            Assert.Equal(passwordAfter, password.StatusCode);
            Assert.True(await ReadAsync(pg.SharedHost, db => db.Users.IgnoreQueryFilters().Where(u => u.Id == club.MemberId).Select(u => u.EmailVerified).SingleAsync()));
        }

        /// <summary>BP-12: a membership suspended inside the link's fifteen minutes gets no session.</summary>
        [SkippableFact]
        public async Task A_welcome_link_to_a_suspended_membership_signs_nobody_in()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "magsus");
            await WriteAsync(pg.SharedHost, async db => (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.Id == club.MembershipId)).Status = MembershipStatus.Suspended);
            var token = await AddTokenAsync(pg.SharedHost, club, club.MemberId, TokenKind.MagicLink, TimeSpan.FromMinutes(15));

            using var response = await Anonymous(pg.SharedHost, club.Host).PostAsync($"/api/v1/auth/magic-link/{token}", null);

            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal("not_approved", await ErrorOf(response));
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
        }

        /// <summary>A reset link was mailed to the address, so using it proves the address.</summary>
        [SkippableFact]
        public async Task Choosing_a_password_from_a_reset_link_confirms_the_address()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "reset");
            await WriteAsync(pg.SharedHost, async db => (await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Id == club.MemberId)).EmailVerified = false);
            var token = await AddTokenAsync(pg.SharedHost, club, club.MemberId, TokenKind.PasswordReset, TimeSpan.FromHours(1));

            using var reset = await Anonymous(pg.SharedHost, club.Host).PostAsJsonAsync("/api/v1/auth/reset-password", new { token, newPassword = "A-new-password-9" });
            Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
            Assert.True(await ReadAsync(pg.SharedHost, db => db.Users.IgnoreQueryFilters().Where(u => u.Id == club.MemberId).Select(u => u.EmailVerified).SingleAsync()));
        }

        /// <summary>
        /// BP-14: the screen gives a stranger nothing to tell an existing address from a new one —
        /// the same status and the same body.
        /// </summary>
        [SkippableFact]
        public async Task An_existing_address_and_a_new_one_get_the_same_answer()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "enum");
            using var client = Anonymous(pg.SharedHost, club.Host);

            using var existing = await TestPhotos.RegisterAsync(client, club.MemberEmail, $"E-{Guid.NewGuid():N}"[..12]);
            using var fresh = await TestPhotos.RegisterAsync(client, $"f-{Guid.NewGuid():N}@platform.review.test", $"F-{Guid.NewGuid():N}"[..12]);

            Assert.Equal(fresh.StatusCode, existing.StatusCode);
            Assert.Equal(await fresh.Content.ReadAsStringAsync(), await existing.Content.ReadAsStringAsync());
        }

        /// <summary>A hasher that counts verifications, to see the unknown-address path pay one.</summary>
        private sealed class CountingHasher(IPasswordHasher inner) : IPasswordHasher
        {
            public int Verifications;
            public string Hash(string password) => inner.Hash(password);
            public bool Verify(string password, string hash) { Interlocked.Increment(ref Verifications); return inner.Verify(password, hash); }
        }

        /// <summary>
        /// BP-14: an unknown address costs the same hash a real one does, so the reply's timing
        /// does not say which addresses hold accounts. Varied with a known address, wrong password.
        /// </summary>
        [SkippableTheory]
        [InlineData(true)]
        [InlineData(false)]
        public async Task A_sign_in_pays_one_password_hash_whether_or_not_the_address_exists(bool known)
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "time");
            CountingHasher? counting = null;
            await using var app = pg.SharedHost.WithWebHostBuilder(b => b.ConfigureServices(s =>
            {
                var existing = s.Single(d => d.ServiceType == typeof(IPasswordHasher));
                s.Remove(existing);
                s.AddSingleton<IPasswordHasher>(sp =>
                {
                    var inner = (IPasswordHasher)(existing.ImplementationInstance
                        ?? existing.ImplementationFactory?.Invoke(sp)
                        ?? ActivatorUtilities.CreateInstance(sp, existing.ImplementationType!));
                    return counting = new CountingHasher(inner);
                });
            }));

            var email = known ? club.MemberEmail : $"nobody-{Guid.NewGuid():N}@platform.review.test";
            using var response = await Anonymous(app, club.Host).PostAsJsonAsync("/api/v1/auth/login", new { email, password = "Wrong-password-1" });

            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.Equal(1, counting!.Verifications);
        }
    }

    // =================================================================================== uploads

    /// <summary>BP-04: the anonymous upload, bounded.</summary>
    public sealed class Uploads(PostgresFixture pg) : PlatformPassHttpTests, IClassFixture<PostgresFixture>
    {
        /// <summary>The bytes decide: a label is not a type. Varied both ways round.</summary>
        [SkippableFact]
        public async Task The_bytes_decide_what_an_upload_is()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "bytes");
            using var client = Anonymous(pg.SharedHost, club.Host);

            using (var lie = await client.PostAsync("/api/v1/uploads/photo", TestPhotos.Form("not an image at all"u8.ToArray(), "image/jpeg", "x.jpg")))
            {
                Assert.Equal(HttpStatusCode.BadRequest, lie.StatusCode);
                Assert.Equal("unsupported_content_type", await ErrorOf(lie));
            }

            using var honest = await client.PostAsync("/api/v1/uploads/photo", TestPhotos.Form(TestPhotos.Png(), "application/octet-stream", "x.bin"));
            Assert.Equal(HttpStatusCode.OK, honest.StatusCode);
            var url = (await JsonOf(honest)).GetProperty("url").GetString()!;
            Assert.True(MemberPhotoFiles.IsIssued(club.Slug, url));
            Assert.EndsWith(".png", url, StringComparison.Ordinal);
        }

        /// <summary>The anonymous upload is under the auth limit: ten a minute an address, here two.</summary>
        [SkippableFact]
        public async Task The_anonymous_upload_is_rate_limited()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            await using var limited = new TestWebAppFactory
            {
                ConnectionString = pg.ConnectionString,
                RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 2 },
            };
            var club = await SeedAsync(limited, "rate");
            using var client = Anonymous(limited, club.Host);

            var statuses = new List<HttpStatusCode>();
            for (var i = 0; i < 3; i++)
            {
                using var r = await client.PostAsync("/api/v1/uploads/photo", TestPhotos.Form(TestPhotos.Png()));
                statuses.Add(r.StatusCode);
            }

            Assert.Equal([HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests], statuses);
        }

        /// <summary>
        /// One club's recent intake is capped (here the floor, one maximum photo): past it the
        /// club's uploads pause, and another club's do not.
        /// </summary>
        [SkippableFact]
        public async Task A_clubs_recent_intake_is_capped_and_only_that_clubs()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var media = Directory.CreateTempSubdirectory("platform-media-").FullName;
            try
            {
                await using var capped = pg.SharedHost.WithWebHostBuilder(b => b
                    .UseSetting("Media:StoragePath", media)
                    .UseSetting("Uploads:RecentBytesPerClub", "1"));
                var club = await SeedAsync(capped, "cap");
                var other = await SeedAsync(capped, "cap");
                var big = TestPhotos.Png(3 * 1024 * 1024);

                using var first = await Anonymous(capped, club.Host).PostAsync("/api/v1/uploads/photo", TestPhotos.Form(big));
                using var second = await Anonymous(capped, club.Host).PostAsync("/api/v1/uploads/photo", TestPhotos.Form(big));
                using var elsewhere = await Anonymous(capped, other.Host).PostAsync("/api/v1/uploads/photo", TestPhotos.Form(big));

                Assert.Equal(HttpStatusCode.OK, first.StatusCode);
                Assert.Equal(HttpStatusCode.ServiceUnavailable, second.StatusCode);
                Assert.Equal("uploads_paused", await ErrorOf(second));
                Assert.Equal(HttpStatusCode.OK, elsewhere.StatusCode);
            }
            finally
            {
                Directory.Delete(media, recursive: true);
            }
        }

        /// <summary>
        /// The sweep removes what no membership in ANY club references once it is old enough, and
        /// nothing else: a referenced photo, a fresh upload (its registration may be on its way),
        /// another club's referenced photo, and a file this product did not name all stay.
        /// </summary>
        [SkippableFact]
        public async Task The_orphan_sweep_removes_only_old_files_nobody_references()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var media = Directory.CreateTempSubdirectory("platform-sweep-").FullName;
            try
            {
                var club = await SeedAsync(pg.SharedHost, "sweep");
                var other = await SeedAsync(pg.SharedHost, "sweep");
                var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Media:StoragePath"] = media, ["Uploads:OrphanAfterMinutes"] = "60",
                }).Build();
                var photos = new MemberPhotoFiles(config, NullLogger<MemberPhotoFiles>.Instance);

                string Make(string slug, string name, TimeSpan age)
                {
                    var dir = Path.Combine(media, slug, "photos");
                    Directory.CreateDirectory(dir);
                    var path = Path.Combine(dir, name);
                    File.WriteAllBytes(path, TestPhotos.Png());
                    File.SetLastWriteTimeUtc(path, DateTime.UtcNow - age);
                    return MemberPhotoFiles.PrefixOf(slug) + name;
                }

                var orphan = Make(club.Slug, $"{Guid.NewGuid():N}.png", TimeSpan.FromHours(3));
                var kept = Make(club.Slug, $"{Guid.NewGuid():N}.png", TimeSpan.FromHours(3));
                var fresh = Make(club.Slug, $"{Guid.NewGuid():N}.png", TimeSpan.FromMinutes(5));
                var othersKept = Make(other.Slug, $"{Guid.NewGuid():N}.jpg", TimeSpan.FromHours(3));
                var othersOrphan = Make(other.Slug, $"{Guid.NewGuid():N}.jpg", TimeSpan.FromHours(3));
                Make(club.Slug, "notes.txt", TimeSpan.FromDays(3));
                await WriteAsync(pg.SharedHost, async db =>
                {
                    (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.Id == club.MembershipId)).PhotoUrl = kept;
                    (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.Id == other.MembershipId)).PhotoUrl = othersKept;
                });

                var worker = new PhotoOrphanSweepWorker(pg.SharedHost.Services.GetRequiredService<IServiceScopeFactory>(), photos, NullLogger<PhotoOrphanSweepWorker>.Instance);
                Assert.Equal(2, await worker.SweepAsync(DateTimeOffset.UtcNow, default));

                Assert.False(photos.Exists(club.Slug, orphan));
                Assert.False(photos.Exists(other.Slug, othersOrphan));
                Assert.True(photos.Exists(club.Slug, kept));
                Assert.True(photos.Exists(club.Slug, fresh));
                Assert.True(photos.Exists(other.Slug, othersKept));
                Assert.True(File.Exists(Path.Combine(media, club.Slug, "photos", "notes.txt")));
            }
            finally
            {
                Directory.Delete(media, recursive: true);
            }
        }
    }

    // =================================================================================== passkeys, PIN, biometric

    /// <summary>BP-10, BP-16 (passkeys), BP-11 (the desk's PIN), BP-09 (biometric enrolment).</summary>
    public sealed class Credentials(PostgresFixture pg) : PlatformPassHttpTests, IClassFixture<PostgresFixture>
    {
        /// <summary>The anonymous passkey options route is under the sign-in limit (it was under none).</summary>
        [SkippableFact]
        public async Task Passkey_sign_in_options_are_rate_limited()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            await using var limited = new TestWebAppFactory
            {
                ConnectionString = pg.ConnectionString,
                RateLimits = new Dictionary<string, int> { ["AuthPerIpPerMinute"] = 3 },
            };
            var club = await SeedAsync(limited, "pkrate");
            using var client = Anonymous(limited, club.Host);

            var statuses = new List<HttpStatusCode>();
            for (var i = 0; i < 4; i++)
            {
                using var r = await client.PostAsync("/api/v1/auth/webauthn/login/options", null);
                statuses.Add(r.StatusCode);
            }

            Assert.Equal([HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests], statuses);
        }

        /// <summary>A passkey removed is announced to the member and audited: a hijacker's change is seen.</summary>
        [SkippableFact]
        public async Task Removing_a_passkey_mails_the_member_and_writes_an_audit_row()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var mail = new CapturingMail();
            await using var app = CapturingMail.On(pg.SharedHost, mail);
            var club = await SeedAsync(app, "pkdel");
            var credential = new WebAuthnCredential
            {
                TenantId = club.TenantId, UserId = club.MemberId, CredentialId = Guid.NewGuid().ToByteArray(),
                PublicKey = [1, 2, 3], UserHandle = [4, 5, 6], Label = "Work laptop",
            };
            await WriteAsync(app, db => { db.WebAuthnCredentials.Add(credential); return Task.CompletedTask; });

            using var response = await Signed(app, club, club.MemberId).DeleteAsync($"/api/v1/me/webauthn/credentials/{credential.Id}");

            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            var told = Assert.Single(mail.Sent, m => m.To == club.MemberEmail);
            Assert.Equal("A passkey was removed from your account", told.Subject);
            Assert.Contains("Work laptop", told.HtmlBody, StringComparison.Ordinal);
            Assert.True(await ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters().AnyAsync(a => a.SubjectUserId == club.MemberId && a.Action == "user.passkey_removed")));
        }

        /// <summary>BP-16: a credential id held by any account, in any club, is not free.</summary>
        [SkippableFact]
        public async Task A_credential_id_held_anywhere_is_not_free()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "pkdup");
            var id = Guid.NewGuid().ToByteArray();
            await WriteAsync(pg.SharedHost, db =>
            {
                db.WebAuthnCredentials.Add(new WebAuthnCredential
                {
                    TenantId = club.TenantId, UserId = club.MemberId, CredentialId = id, PublicKey = [1], UserHandle = [2], Label = "Phone",
                });
                return Task.CompletedTask;
            });

            using var scope = pg.SharedHost.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.False(await WebAuthnEndpoints.CredentialIdIsFreeAsync(db, id, default));
            Assert.True(await WebAuthnEndpoints.CredentialIdIsFreeAsync(db, Guid.NewGuid().ToByteArray(), default));
        }

        /// <summary>
        /// BP-11: the desk setting a member's PIN is on the club's change record — never the PIN —
        /// and the member is told. It was an audit_log row only, and silent.
        /// </summary>
        [SkippableFact]
        public async Task The_desk_setting_a_pin_is_recorded_and_told_to_the_member_without_the_pin()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var mail = new CapturingMail();
            await using var app = CapturingMail.On(pg.SharedHost, mail);
            var club = await SeedAsync(app, "pin");

            using var response = await Signed(app, club, club.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/members/{club.MembershipId}/pin", new { pin = "4731" });

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True((await JsonOf(response)).GetProperty("member_email_queued").GetBoolean());
            var change = await ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters().SingleAsync(c => c.TenantId == club.TenantId && c.Action == AdminChangeActions.MemberPinSet));
            Assert.Equal(club.AdminId, change.ActorUserId);
            Assert.Equal(club.MemberId, change.SubjectId);
            Assert.DoesNotContain("4731", (change.BeforeJson ?? "") + change.AfterJson, StringComparison.Ordinal);
            var told = Assert.Single(mail.Sent, m => m.To == club.MemberEmail);
            Assert.Equal("The club set your court PIN", told.Subject);
            Assert.DoesNotContain("4731", told.HtmlBody + told.PlainBody, StringComparison.Ordinal);
        }

        /// <summary>
        /// BP-09: biometric enrolment takes a member of THIS club only. Another club's user and the
        /// all-zeros id a malformed body binds to both made a template row here.
        /// </summary>
        [SkippableFact]
        public async Task Biometric_enrolment_takes_only_this_clubs_members()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "bio");
            var other = await SeedAsync(pg.SharedHost, "bio");
            using var admin = Signed(pg.SharedHost, club, club.AdminId, "admin");

            foreach (var stranger in new[] { other.MemberId, Guid.Empty })
            {
                using var refused = await admin.PostAsJsonAsync("/api/v1/admin/biometric/enroll", new { userId = stranger, fingerLabel = "right index" });
                Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
                Assert.Equal("member_not_found", await ErrorOf(refused));
            }

            using var own = await admin.PostAsJsonAsync("/api/v1/admin/biometric/enroll", new { userId = club.MemberId, fingerLabel = "right index" });
            Assert.Equal(HttpStatusCode.OK, own.StatusCode);
            Assert.Equal(1, await ReadAsync(pg.SharedHost, db => db.EnrolledTemplates.IgnoreQueryFilters().CountAsync(t => t.TenantId == club.TenantId)));
            Assert.False(await ReadAsync(pg.SharedHost, db => db.EnrolledTemplates.IgnoreQueryFilters().AnyAsync(t => t.TenantId == club.TenantId && t.UserId != club.MemberId)));
        }
    }

    // =================================================================================== operator CLI

    /// <summary>BP-07: a second club onboarded without raw SQL.</summary>
    public sealed class Operator(PostgresFixture pg) : PlatformPassHttpTests, IClassFixture<PostgresFixture>
    {
        private static async Task<(int Code, string Output)> RunAsync(WebApplicationFactory<Program> app, params string[] args)
        {
            using var output = new StringWriter();
            var code = await TenantCli.RunAsync(app.Services, args, output);
            return (code, output.ToString());
        }

        /// <summary>
        /// <c>tenant create</c> makes a club that works end to end: its courts, groups and
        /// packages, and a first admin who has no password until the mailed link sets one — and
        /// whose link lands on the new club's own host and signs them in there.
        /// </summary>
        [SkippableFact]
        public async Task Creating_a_club_makes_one_a_first_admin_can_open_from_the_mail()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var mail = new CapturingMail();
            await using var app = CapturingMail.On(pg.SharedHost, mail);
            var slug = $"cli{Guid.NewGuid():N}"[..14];
            var admin = $"chair-{slug}@platform.review.test";

            var (code, output) = await RunAsync(app, "tenant", "create", "--slug", slug, "--name", "Kestrel Squash", "--admin-email", admin, "--courts", "3");

            Assert.Equal(TenantCli.Ok, code);
            Assert.DoesNotContain("/reset-password/", output, StringComparison.Ordinal);   // a credential, only on --print-link
            var tenantId = await ReadAsync(app, db => db.Tenants.Where(t => t.Slug == slug).Select(t => t.Id).SingleAsync());
            Assert.Equal(3, await ReadAsync(app, db => db.Courts.IgnoreQueryFilters().CountAsync(c => c.TenantId == tenantId)));
            Assert.True(await ReadAsync(app, db => db.MemberGroups.IgnoreQueryFilters().AnyAsync(g => g.TenantId == tenantId)));
            Assert.True(await ReadAsync(app, db => db.MinutePackages.IgnoreQueryFilters().AnyAsync(p => p.TenantId == tenantId)));
            var account = await ReadAsync(app, db => db.Users.IgnoreQueryFilters().SingleAsync(u => u.TenantId == tenantId));
            Assert.True(account.IsAdmin);
            Assert.Null(account.PasswordHash);

            var (url, token) = LinkIn(Assert.Single(mail.Sent, m => m.To == admin), "reset-password");
            Assert.Equal($"http://{slug}.localhost:8088", url);
            using var set = await Anonymous(app, new Uri(url).Authority).PostAsJsonAsync("/api/v1/auth/reset-password", new { token, newPassword = "Chair-password-9" });
            Assert.Equal(HttpStatusCode.OK, set.StatusCode);
            using var login = await Anonymous(app, new Uri(url).Authority).PostAsJsonAsync("/api/v1/auth/login", new { email = admin, password = "Chair-password-9" });
            Assert.Equal(HttpStatusCode.OK, login.StatusCode);
            Assert.True((await JsonOf(login)).GetProperty("is_admin").GetBoolean());
        }

        [SkippableTheory]
        [InlineData("Bad_Slug", "--slug must be")]
        [InlineData("-lead", "--slug must be")]
        [InlineData("www", "reserved")]
        public async Task A_slug_that_cannot_be_a_host_label_is_refused(string slug, string says)
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var (code, output) = await RunAsync(pg.SharedHost, "tenant", "create", "--slug", slug, "--name", "X", "--admin-email", "x@platform.review.test");
            Assert.Equal(TenantCli.Failed, code);
            Assert.Contains(says, output, StringComparison.Ordinal);
            Assert.False(await ReadAsync(pg.SharedHost, db => db.Tenants.AnyAsync(t => t.Slug == slug.ToLowerInvariant())));
        }

        [SkippableFact]
        public async Task An_existing_slug_is_refused_and_nothing_changes()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "dupe");
            var (code, output) = await RunAsync(pg.SharedHost, "tenant", "create", "--slug", club.Slug, "--name", "Again", "--admin-email", "again@platform.review.test");
            Assert.Equal(TenantCli.Failed, code);
            Assert.Contains("already exists", output, StringComparison.Ordinal);
            Assert.Equal(2, await ReadAsync(pg.SharedHost, db => db.Users.IgnoreQueryFilters().CountAsync(u => u.TenantId == club.TenantId)));
        }

        /// <summary>
        /// Suspending closes the club (on a host that has not cached it yet, at once); activating
        /// reopens it; doing either twice is a no-op that says so.
        /// </summary>
        [SkippableFact]
        public async Task Suspending_and_reopening_a_club_takes_effect_and_is_idempotent()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "toggle");

            Assert.Equal(TenantCli.Ok, (await RunAsync(pg.SharedHost, "tenant", "suspend", "--slug", club.Slug)).Code);
            Assert.Contains("already suspended", (await RunAsync(pg.SharedHost, "tenant", "suspend", "--slug", club.Slug)).Output, StringComparison.Ordinal);
            await using (var fresh = new TestWebAppFactory { ConnectionString = pg.ConnectionString })
            {
                using var closed = await Signed(fresh, club, club.MemberId).GetAsync("/api/v1/me/profile");
                Assert.Equal("club_suspended", await ErrorOf(closed));
            }

            Assert.Equal(TenantCli.Ok, (await RunAsync(pg.SharedHost, "tenant", "activate", "--slug", club.Slug)).Code);
            await using var later = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
            using var open = await Signed(later, club, club.MemberId).GetAsync("/api/v1/me/profile");
            Assert.Equal(HttpStatusCode.OK, open.StatusCode);
            Assert.Equal(2, await ReadAsync(pg.SharedHost, db => db.AuditLogs.IgnoreQueryFilters().CountAsync(a => a.TenantId == club.TenantId && a.Action.StartsWith("tenant."))));
        }

        /// <summary>An address that would not resolve back to the club is refused; a good one is kept.</summary>
        [SkippableFact]
        public async Task A_clubs_address_must_resolve_back_to_it()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var club = await SeedAsync(pg.SharedHost, "url");

            var (refusedCode, refused) = await RunAsync(pg.SharedHost, "tenant", "set-url", "--slug", club.Slug, "--public-base-url", "https://someone-else.example.net");
            Assert.Equal(TenantCli.Failed, refusedCode);
            Assert.Contains("resolves to the club 'someone-else'", refused, StringComparison.Ordinal);

            Assert.Equal(TenantCli.Ok, (await RunAsync(pg.SharedHost, "tenant", "set-url", "--slug", club.Slug, "--public-base-url", $"https://{club.Slug}.example.net/")).Code);
            Assert.Equal($"https://{club.Slug}.example.net", await ReadAsync(pg.SharedHost, db => db.Tenants.Where(t => t.Id == club.TenantId).Select(t => t.PublicBaseUrl).SingleAsync()));
            Assert.Contains(club.Slug, (await RunAsync(pg.SharedHost, "tenant", "list")).Output, StringComparison.Ordinal);
        }

        [SkippableFact]
        public async Task An_unknown_command_prints_the_usage()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            var (code, output) = await RunAsync(pg.SharedHost, "tenant", "rename", "--slug", "x");
            Assert.Equal(TenantCli.Usage, code);
            Assert.Contains("usage:", output, StringComparison.Ordinal);
            Assert.True(TenantCli.IsCommand(["tenant", "list"]));
            Assert.False(TenantCli.IsCommand([]));
        }

        /// <summary>Readiness with the database present: 200, and the build it is.</summary>
        [SkippableFact]
        public async Task Readiness_is_ready_with_its_database()
        {
            Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
            using var response = await pg.SharedHost.CreateClient().GetAsync("/readyz");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await JsonOf(response);
            Assert.Equal("ready", body.GetProperty("status").GetString());
            Assert.Equal("ok", body.GetProperty("database").GetString());
            Assert.Equal(BuildInfo.Current.Revision, body.GetProperty("revision").GetString());
        }
    }
}
