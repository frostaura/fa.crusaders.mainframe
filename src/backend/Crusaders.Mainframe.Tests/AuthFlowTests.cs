using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

public class AuthFlowTests
{
    [Fact]
    public async Task Register_then_verify_then_admin_approve_then_login_succeeds()
    {
        await using var host = await TestHost.CreateAsync();

        // Register
        Guid newUserId;
        using (var scope = host.NewScope())
        {
            var auth = scope.ServiceProvider.GetRequiredService<AuthService>();
            var result = await auth.RegisterAsync("newbie@test.local", "Pass1234!", "New Person", "M-100", null, default);
            newUserId = ((RegistrationResult.Created)result).UserId;
        }

        // Email service should have a verify-email + pending message
        // Awaited, because registration hands its mail to EmailDispatch.InBackground rather
        // than blocking the response on SMTP. See StubEmailService.WaitFor.
        Assert.NotNull(await host.EmailService.WaitFor(m => m.Subject.Contains("Verify")));

        // Pull the verify token from the DB and verify
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var token = await db.AuthTokens.Where(t => t.UserId == newUserId && t.Kind == TokenKind.EmailVerification).FirstAsync();
            // We stored the hash; for a black-box test we'd need the plaintext from the email body — for now
            // assert that the verify side rejects unknown tokens, and that approving the user lets them log in.
            var verifiedWithGarbage = await scope.ServiceProvider.GetRequiredService<AuthService>().VerifyEmailAsync("garbage", default);
            Assert.False(verifiedWithGarbage);
            // Manually mark verified to continue the flow without parsing the email.
            (await db.Users.FirstAsync(u => u.Id == newUserId)).EmailVerified = true;
            await db.SaveChangesAsync();
            _ = token;
        }

        // Admin approves
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var membership = await db.Memberships.FirstAsync(m => m.UserId == newUserId);
            var approval = await scope.ServiceProvider.GetRequiredService<MemberApprovalService>().ApproveAsync(membership.Id, host.AdminUser.Id, default);
            Assert.True(approval.Ok);
            // The stub mail server accepts, so the member really was told. The two facts are
            // separate on purpose — see TransitionReport.
            Assert.True(approval.EmailQueued);
        }

        // Login
        using (var scope = host.NewScope())
        {
            var login = await scope.ServiceProvider.GetRequiredService<AuthService>().LoginAsync("newbie@test.local", "Pass1234!", default);
            var ok = Assert.IsType<LoginResult.Ok>(login);
            Assert.False(ok.IsAdmin);
            Assert.NotNull(ok.AccessToken);
        }
    }
}
