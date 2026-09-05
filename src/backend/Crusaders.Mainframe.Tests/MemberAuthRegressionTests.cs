using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The member-facing authentication defects a browser-driven pass found, pinned at the service
/// layer. Every test here was watched to fail against the code as it stood.
///
/// <para>
/// The shape they share is worth naming: none of them was a crash. Each was the product doing
/// something coherent that was not what the spec promised and not what the screen said — a
/// duplicate membership number surfacing as "Try again", an approved member told they were not
/// approved, a temporary password that was permanent. Green tests cannot find that class of
/// defect; only reading the promise and checking it can.
/// </para>
/// </summary>
public class MemberAuthRegressionTests
{
    private static AuthService Auth(IServiceScope scope) => scope.ServiceProvider.GetRequiredService<AuthService>();

    /// <summary>
    /// A duplicate membership number is a conflict with a name, not an unhandled 23505.
    ///
    /// <para>
    /// It used to reach <c>SaveChangesAsync</c> and come back as a <c>DbUpdateException</c>, which
    /// the API returned as a 500 carrying the EF exception and the screen rendered as
    /// "Registration failed. Try again." — advice that could not work, for a mistake (a mistyped
    /// digit on a club-issued number) that is entirely ordinary.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_taken_membership_number_is_its_own_answer_not_a_database_error()
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var result = await Auth(scope).RegisterAsync(
            "clash@test.local", "Pass1234!", "Number Clash", "PLAYER-1", null, default);

        Assert.IsType<RegistrationResult.MembershipNumberInUse>(result);
    }

    /// <summary>The email collision keeps its own answer — the two are distinguishable.</summary>
    [Fact]
    public async Task A_taken_email_is_still_reported_as_a_taken_email()
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var result = await Auth(scope).RegisterAsync(
            host.PlayerUser.Email, "Pass1234!", "Email Clash", "FRESH-1", null, default);

        Assert.IsType<RegistrationResult.AlreadyExists>(result);
    }

    /// <summary>
    /// A refused registration does not leave its photo behind.
    ///
    /// <para>
    /// The browser uploads the selfie before it posts the registration, so every refusal used to
    /// leave a file on the media volume, tied to nobody and reaped by nothing — against an upload
    /// endpoint that is anonymous by design.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_refused_registration_takes_its_orphaned_photo_with_it()
    {
        await using var host = await TestHost.CreateAsync();
        var (url, path) = SeedPhoto(host, "orphan.png");

        using (var scope = host.NewScope())
        {
            await Auth(scope).RegisterAsync(host.PlayerUser.Email, "Pass1234!", "Email Clash", "FRESH-2", url, default);
        }

        Assert.False(File.Exists(path), "the photo uploaded for a registration that was refused is still on disk");
    }

    /// <summary>
    /// The orphan sweep will not delete a photo that belongs to somebody.
    ///
    /// <para>
    /// This is the reason the sweep checks the membership table rather than just deleting the file
    /// the request named. The photo URL arrives in an <b>anonymous</b> request body, so a sweep
    /// that trusted it would let anyone erase a real member's photo by registering with that
    /// member's photo URL and an email they knew would be refused.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_registration_cannot_delete_a_photo_that_belongs_to_a_real_member()
    {
        await using var host = await TestHost.CreateAsync();
        var (url, path) = SeedPhoto(host, "victim.png");

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var victim = await db.Memberships.FirstAsync(m => m.UserId == host.PlayerUser.Id);
            victim.PhotoUrl = url;
            await db.SaveChangesAsync();
        }

        using (var scope = host.NewScope())
        {
            await Auth(scope).RegisterAsync(host.LeaguePlayerUser.Email, "Pass1234!", "Attacker", "FRESH-3", url, default);
        }

        Assert.True(File.Exists(path), "an anonymous failed registration erased an existing member's photo");
    }

    /// <summary>
    /// Spec §2.3 promises the club's admins are told. Both registration emails went to the
    /// applicant and nothing went to an admin, so the only cue was a counter on a screen an admin
    /// had to think to open.
    /// </summary>
    [Fact]
    public async Task Registering_tells_the_clubs_admins_somebody_is_waiting()
    {
        await using var host = await TestHost.CreateAsync();

        using (var scope = host.NewScope())
        {
            await Auth(scope).RegisterAsync("applicant@test.local", "Pass1234!", "New Applicant", "NEW-1", null, default);
        }

        var toAdmin = host.EmailService.Sent.Where(m => m.To == host.AdminUser.Email).ToList();
        Assert.NotEmpty(toAdmin);
        Assert.Contains(toAdmin, m => m.Subject.Contains("New membership application", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(toAdmin, m => m.HtmlBody.Contains("applicant@test.local", StringComparison.Ordinal));

        // EXACTLY one. Two fixers closed spec §2.3 in parallel — a helper in AuthService and
        // MemberApprovalService.AnnounceRegistrationAsync — and the merge kept both, so the
        // club's desk got two near-identical emails per application. `Contains` passed happily
        // through that, which is why the count is asserted and not merely the presence.
        Assert.Single(toAdmin, m => m.Subject.Contains("New membership application", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Consuming the welcome link confirms the address, because the link was emailed to it.
    ///
    /// <para>
    /// Verification was enforced on the password ingress and skipped entirely here, so the same
    /// member was refused at sign-in and waved through by the welcome email. One of the two had to
    /// give; refusing the ingress that carries the actual proof of control would have been the
    /// wrong one.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_welcome_link_confirms_the_address_it_was_sent_to()
    {
        await using var host = await TestHost.CreateAsync();
        var userId = await SeedApprovedButUnverifiedAsync(host, "magic@test.local", "Pass1234!");
        var token = await IssueTokenAsync(host, userId, TokenKind.MagicLink, TimeSpan.FromMinutes(15));

        using (var scope = host.NewScope())
        {
            Assert.IsType<LoginResult.Ok>(await Auth(scope).ConsumeMagicLinkAsync(token, default));
        }

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.True((await db.Users.FirstAsync(u => u.Id == userId)).EmailVerified);
            // And the ingress that used to refuse them now lets them in.
            Assert.IsType<LoginResult.Ok>(await Auth(scope).LoginAsync("magic@test.local", "Pass1234!", default));
        }
    }

    /// <summary>
    /// The resend endpoint sends to a member who needs it and stays silent about everyone else.
    ///
    /// <para>
    /// The silence is the point: an honest answer would say whether an address is registered and
    /// whether it is verified, which is an account-enumeration oracle on an anonymous endpoint.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Resending_verification_mails_the_member_and_tells_the_caller_nothing()
    {
        await using var host = await TestHost.CreateAsync();
        await SeedApprovedButUnverifiedAsync(host, "resend@test.local", "Pass1234!");

        using (var scope = host.NewScope())
        {
            await Auth(scope).ResendVerificationAsync("resend@test.local", default);
            await Auth(scope).ResendVerificationAsync("nobody-at-all@test.local", default);
            // A verified member has nothing to re-send either.
            await Auth(scope).ResendVerificationAsync(host.PlayerUser.Email, default);
        }

        Assert.Single(host.EmailService.Sent, m => m.To == "resend@test.local" && m.Subject.Contains("Verify"));
        Assert.DoesNotContain(host.EmailService.Sent, m => m.To == "nobody-at-all@test.local");
        Assert.DoesNotContain(host.EmailService.Sent, m => m.To == host.PlayerUser.Email && m.Subject.Contains("Verify"));
    }

    /// <summary>A second resend retires the first link, so one account never has two live ones.</summary>
    [Fact]
    public async Task Resending_verification_spends_the_link_it_replaces()
    {
        await using var host = await TestHost.CreateAsync();
        await SeedApprovedButUnverifiedAsync(host, "twice@test.local", "Pass1234!");

        using (var scope = host.NewScope())
        {
            await Auth(scope).ResendVerificationAsync("twice@test.local", default);
            await Auth(scope).ResendVerificationAsync("twice@test.local", default);
        }

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var live = await db.AuthTokens.CountAsync(t => t.Kind == TokenKind.EmailVerification && t.UsedAt == null);
            Assert.Equal(1, live);
        }
    }

    /// <summary>
    /// An admin-issued temporary password arms a forced change, and the change disarms it.
    ///
    /// <para>
    /// Before this the response's own advice — "They should change it on first login" — was the
    /// entire mechanism. The password stayed the account's password indefinitely, having been
    /// emailed in plaintext and shown on an admin's screen.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_admin_issued_password_forces_a_change_and_the_change_clears_it()
    {
        await using var host = await TestHost.CreateAsync();
        await ArmTemporaryPasswordAsync(host, host.PlayerUser.Id, "TempPass123!");

        using (var scope = host.NewScope())
        {
            var login = Assert.IsType<LoginResult.Ok>(await Auth(scope).LoginAsync(host.PlayerUser.Email, "TempPass123!", default));
            Assert.True(login.MustChangePassword);
        }

        using (var scope = host.NewScope())
        {
            var changed = await Auth(scope).ChangePasswordAsync(host.PlayerUser.Id, "TempPass123!", "ChosenByMe1!", default);
            Assert.Equal(PasswordChangeResult.Ok, changed);
        }

        using (var scope = host.NewScope())
        {
            // The temporary password is gone, and the chosen one carries no forced change.
            Assert.IsType<LoginResult.InvalidCredentials>(await Auth(scope).LoginAsync(host.PlayerUser.Email, "TempPass123!", default));
            var login = Assert.IsType<LoginResult.Ok>(await Auth(scope).LoginAsync(host.PlayerUser.Email, "ChosenByMe1!", default));
            Assert.False(login.MustChangePassword);
        }
    }

    /// <summary>A forced change must be a real change — the same password again is refused.</summary>
    [Fact]
    public async Task Changing_a_password_to_the_same_password_is_refused()
    {
        await using var host = await TestHost.CreateAsync();
        await ArmTemporaryPasswordAsync(host, host.PlayerUser.Id, "TempPass123!");

        using var scope = host.NewScope();
        var result = await Auth(scope).ChangePasswordAsync(host.PlayerUser.Id, "TempPass123!", "TempPass123!", default);

        Assert.Equal(PasswordChangeResult.Unchanged, result);
    }

    /// <summary>A wrong current password is its own answer, and leaves the account untouched.</summary>
    [Fact]
    public async Task A_wrong_current_password_changes_nothing()
    {
        await using var host = await TestHost.CreateAsync();

        using (var scope = host.NewScope())
        {
            var result = await Auth(scope).ChangePasswordAsync(host.PlayerUser.Id, "NotMyPassword!", "Whatever123!", default);
            Assert.Equal(PasswordChangeResult.CurrentPasswordWrong, result);
        }

        using (var scope = host.NewScope())
        {
            Assert.IsType<LoginResult.Ok>(await Auth(scope).LoginAsync(host.PlayerUser.Email, "PlayerPass!", default));
        }
    }

    /// <summary>The self-service reset link also retires whatever an admin issued.</summary>
    [Fact]
    public async Task A_self_service_reset_clears_the_forced_change()
    {
        await using var host = await TestHost.CreateAsync();
        await ArmTemporaryPasswordAsync(host, host.PlayerUser.Id, "TempPass123!");
        var token = await IssueTokenAsync(host, host.PlayerUser.Id, TokenKind.PasswordReset, TimeSpan.FromHours(1));

        using (var scope = host.NewScope())
        {
            Assert.True(await Auth(scope).ResetPasswordAsync(token, "ResetByMe12!", default));
        }

        using (var scope = host.NewScope())
        {
            var login = Assert.IsType<LoginResult.Ok>(await Auth(scope).LoginAsync(host.PlayerUser.Email, "ResetByMe12!", default));
            Assert.False(login.MustChangePassword);
        }
    }

    // ---- helpers -------------------------------------------------------------------------

    /// <summary>Writes a file where the upload endpoint would have put it, and returns both halves.</summary>
    private static (string Url, string Path) SeedPhoto(TestHost host, string fileName)
    {
        var dir = Path.Combine(host.MediaRoot, host.Tenant.Slug, "photos");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, fileName);
        File.WriteAllBytes(path, new byte[] { 0x89, 0x50, 0x4E, 0x47 });
        return ($"/uploads/{host.Tenant.Slug}/photos/{fileName}", path);
    }

    /// <summary>An active member whose address was never confirmed — F3's exact shape.</summary>
    private static async Task<Guid> SeedApprovedButUnverifiedAsync(TestHost host, string email, string password)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();

        var user = new User
        {
            TenantId = host.Tenant.Id,
            Email = email,
            PasswordHash = hasher.Hash(password),
            EmailVerified = false,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = host.Tenant.Id,
            UserId = user.Id,
            FullName = "Unverified Member",
            MembershipNumber = $"UNV-{Guid.NewGuid():N}"[..12],
            Status = MembershipStatus.Active,
        });
        await db.SaveChangesAsync();
        return user.Id;
    }

    private static async Task<string> IssueTokenAsync(TestHost host, Guid userId, TokenKind kind, TimeSpan ttl)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var token = TokenHashing.Generate();
        db.AuthTokens.Add(new AuthToken
        {
            TenantId = host.Tenant.Id,
            UserId = userId,
            Kind = kind,
            TokenHash = TokenHashing.Hash(token),
            ExpiresAt = DateTimeOffset.UtcNow.Add(ttl),
        });
        await db.SaveChangesAsync();
        return token;
    }

    /// <summary>What the admin reset-password endpoint leaves behind on the user row.</summary>
    private static async Task ArmTemporaryPasswordAsync(TestHost host, Guid userId, string tempPassword)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        var user = await db.Users.FirstAsync(u => u.Id == userId);
        user.PasswordHash = hasher.Hash(tempPassword);
        user.MustChangePassword = true;
        await db.SaveChangesAsync();
    }
}
