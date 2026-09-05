using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Refuses every authenticated request from a user whose password must be changed, except the
/// handful of calls needed to change it.
///
/// <para>
/// Spec §3 says an admin-issued temporary password "forces a password reset on first use". What
/// the product did was <i>advise</i> one — the reset response literally returned "They should
/// change it on first login" — so a password that had been emailed in plaintext and displayed on
/// an admin's screen became the account's permanent credential. Routing the browser to a
/// change-password screen would not have fixed that either: a redirect is a suggestion to
/// whatever is holding the token, and the token was a full session.
/// </para>
///
/// <para>
/// So the refusal lives here, in front of every endpoint, and the browser's redirect becomes the
/// pleasant version of a rule the API enforces regardless. The answer is 403 with
/// <c>password_change_required</c> and never 401: a 401 is the client's session-expired signal
/// and would bounce the member to a sign-in screen they can sign into, forever.
/// </para>
/// </summary>
public sealed class PasswordChangeGate
{
    /// <summary>
    /// What a must-change session may still reach: the change itself, the session plumbing
    /// around it, and the anonymous surfaces that never had a user to gate.
    /// </summary>
    private static readonly string[] AllowedPrefixes =
    {
        "/healthz",
        "/uploads/",
        "/api/v1/whoami",
        "/api/v1/auth/",      // login, refresh, forgot-password, reset-password, magic-link
        "/api/v1/me/password",
        "/api/v1/device/",    // device surface — authenticates as a box, never as a person
    };

    private readonly RequestDelegate _next;

    public PasswordChangeGate(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context, MainframeDbContext db)
    {
        if (ShouldCheck(context) && context.User.Id() is { } userId)
        {
            var mustChange = await db.Users
                .IgnoreQueryFilters()
                .Where(u => u.Id == userId)
                .Select(u => u.MustChangePassword)
                .FirstOrDefaultAsync(context.RequestAborted);

            if (mustChange)
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                await context.Response.WriteAsJsonAsync(new
                {
                    error = "password_change_required",
                    message = "Your password was reset by an admin. Choose a new one before continuing.",
                });
                return;
            }
        }

        await _next(context);
    }

    private static bool ShouldCheck(HttpContext context)
    {
        if (context.User.Identity?.IsAuthenticated != true) return false;
        var path = context.Request.Path.Value ?? string.Empty;
        return !AllowedPrefixes.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase));
    }
}
