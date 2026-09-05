using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

public sealed class AuthService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IPasswordHasher _hasher;
    private readonly IJwtIssuer _jwt;
    private readonly IEmailService _email;
    private readonly IConfiguration _config;
    private readonly ILogger<AuthService> _logger;
    private readonly MemberApprovalService _memberships;

    public AuthService(MainframeDbContext db, ITenantContext tenant, IPasswordHasher hasher,
        IJwtIssuer jwt, IEmailService email, IConfiguration config, ILogger<AuthService> logger,
        MemberApprovalService memberships)
    {
        _db = db; _tenant = tenant; _hasher = hasher; _jwt = jwt;
        _email = email; _config = config; _logger = logger; _memberships = memberships;
    }

    /// <summary>
    /// Sends, and treats a mail failure as a mail failure rather than as a failed request.
    ///
    /// <para>
    /// These sends come <b>after</b> the SaveChanges that creates the account, so letting an
    /// SMTP exception out returned 500 for a registration that had already succeeded. The
    /// member is told it failed, tries again, and is met with "email already registered" —
    /// with no way forward, because the address is genuinely taken by their own invisible
    /// account. An unreachable mail server is a support call; it is not a reason to refuse
    /// somebody an account that already exists.
    /// </para>
    ///
    /// <para>
    /// This does not soften "every player-affecting event sends an email". The send is still
    /// attempted and a failure is still logged loudly; what changes is that the ledger of
    /// record and the mail server are allowed to fail independently, which they will.
    /// </para>
    /// </summary>
    private async Task SendOrLogAsync(EmailMessage message, string what, CancellationToken ct)
    {
        try
        {
            await _email.SendAsync(message, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Email failed: {What}", what);
        }
    }

    public async Task<RegistrationResult> RegisterAsync(string email, string password, string fullName, string membershipNumber, string? photoUrl, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();
        if (await _db.Users.AnyAsync(u => u.Email == email, ct))
            return new RegistrationResult.AlreadyExists();

        var user = new User
        {
            TenantId = _tenant.TenantId,
            Email = email,
            PasswordHash = _hasher.Hash(password),
            EmailVerified = false,
            IsAdmin = false,
        };
        _db.Users.Add(user);
        _db.Memberships.Add(new Membership
        {
            TenantId = _tenant.TenantId,
            UserId = user.Id,
            FullName = fullName,
            MembershipNumber = membershipNumber,
            PhotoUrl = photoUrl,
            Status = MembershipStatus.PendingApproval,
        });

        var token = TokenHashing.Generate();
        _db.AuthTokens.Add(new AuthToken
        {
            TenantId = _tenant.TenantId,
            UserId = user.Id,
            Kind = TokenKind.EmailVerification,
            TokenHash = TokenHashing.Hash(token),
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(24),
        });

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = user.Id,
            SubjectUserId = user.Id,
            Action = "member.registered",
        });

        await _db.SaveChangesAsync(ct);

        var verifyUrl = $"{PublicBaseUrl()}/verify-email/{token}";
        await SendOrLogAsync(EmailTemplates.VerifyEmail(email, verifyUrl), $"verification for {email}", ct);
        await SendOrLogAsync(EmailTemplates.MembershipPending(email), $"pending-approval notice for {email}", ct);

        // Owned by MemberApprovalService, not by this method: it emails the club's admins
        // that an application is waiting (spec §2.3) and emits `member.registered`. Kept as
        // one call so the registration path carries none of it — see
        // MemberApprovalService.AnnounceRegistrationAsync.
        await _memberships.AnnounceRegistrationAsync(user.Id, ct);

        return new RegistrationResult.Created(user.Id);
    }

    public async Task<bool> VerifyEmailAsync(string token, CancellationToken ct)
    {
        var hash = TokenHashing.Hash(token);
        var record = await _db.AuthTokens
            .Where(t => t.TokenHash == hash && t.Kind == TokenKind.EmailVerification && t.UsedAt == null)
            .FirstOrDefaultAsync(ct);
        if (record is null || record.ExpiresAt < DateTimeOffset.UtcNow) return false;

        var user = await _db.Users.FirstAsync(u => u.Id == record.UserId, ct);
        user.EmailVerified = true;
        record.UsedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<LoginResult> LoginAsync(string email, string password, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();
        var query = _db.Users.IgnoreQueryFilters().Where(u => u.Email == email);
        if (_tenant.IsResolved) query = query.Where(u => u.TenantId == _tenant.TenantId);
        var user = await query.FirstOrDefaultAsync(ct);
        if (user is null || user.PasswordHash is null) return new LoginResult.InvalidCredentials();
        if (!_hasher.Verify(password, user.PasswordHash)) return new LoginResult.InvalidCredentials();
        if (!user.EmailVerified) return new LoginResult.EmailNotVerified();

        if (!_tenant.IsResolved)
        {
            var tenant = await _db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == user.TenantId, ct);
            _tenant.Set(tenant.Id, tenant.Slug);
        }

        var membership = await _db.Memberships.IgnoreQueryFilters().FirstOrDefaultAsync(m => m.UserId == user.Id, ct);
        if (membership is not null && membership.Status != MembershipStatus.Active && !user.IsAdmin)
            return new LoginResult.NotApproved(membership.Status);

        user.LastLoginAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        var roles = new List<string>();
        if (user.IsAdmin) roles.Add("admin");
        if (user.IsPlatformAdmin) roles.Add("platform_admin");

        var token = _jwt.IssueAccess(user.Id, _tenant.TenantId, _tenant.TenantSlug, roles);
        return new LoginResult.Ok(token, user.Id, user.IsAdmin);
    }

    public async Task<bool> RequestPasswordResetAsync(string email, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Email == email, ct);
        if (user is null) return false;

        var token = TokenHashing.Generate();
        _db.AuthTokens.Add(new AuthToken
        {
            TenantId = _tenant.TenantId,
            UserId = user.Id,
            Kind = TokenKind.PasswordReset,
            TokenHash = TokenHashing.Hash(token),
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        });
        await _db.SaveChangesAsync(ct);

        var resetUrl = $"{PublicBaseUrl()}/reset-password/{token}";
        await SendOrLogAsync(EmailTemplates.PasswordReset(email, resetUrl), $"password reset for {email}", ct);
        return true;
    }

    public async Task<bool> ResetPasswordAsync(string token, string newPassword, CancellationToken ct)
    {
        var hash = TokenHashing.Hash(token);
        var record = await _db.AuthTokens
            .Where(t => t.TokenHash == hash && t.Kind == TokenKind.PasswordReset && t.UsedAt == null)
            .FirstOrDefaultAsync(ct);
        if (record is null || record.ExpiresAt < DateTimeOffset.UtcNow) return false;

        var user = await _db.Users.FirstAsync(u => u.Id == record.UserId, ct);
        user.PasswordHash = _hasher.Hash(newPassword);
        record.UsedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<LoginResult> ConsumeMagicLinkAsync(string token, CancellationToken ct)
    {
        var hash = TokenHashing.Hash(token);
        var record = await _db.AuthTokens
            .Where(t => t.TokenHash == hash && t.Kind == TokenKind.MagicLink && t.UsedAt == null)
            .FirstOrDefaultAsync(ct);
        if (record is null || record.ExpiresAt < DateTimeOffset.UtcNow) return new LoginResult.InvalidCredentials();

        var user = await _db.Users.FirstAsync(u => u.Id == record.UserId, ct);
        record.UsedAt = DateTimeOffset.UtcNow;
        user.LastLoginAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        var roles = new List<string>();
        if (user.IsAdmin) roles.Add("admin");
        var jwt = _jwt.IssueAccess(user.Id, _tenant.TenantId, _tenant.TenantSlug, roles);
        return new LoginResult.Ok(jwt, user.Id, user.IsAdmin);
    }

    public async Task<LoginResult> RefreshAsync(Guid userId, CancellationToken ct)
    {
        var user = await _db.Users.IgnoreQueryFilters().FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return new LoginResult.InvalidCredentials();
        if (!_tenant.IsResolved)
        {
            var tenant = await _db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == user.TenantId, ct);
            _tenant.Set(tenant.Id, tenant.Slug);
        }
        var roles = new List<string>();
        if (user.IsAdmin) roles.Add("admin");
        if (user.IsPlatformAdmin) roles.Add("platform_admin");
        var token = _jwt.IssueAccess(user.Id, _tenant.TenantId, _tenant.TenantSlug, roles);
        return new LoginResult.Ok(token, user.Id, user.IsAdmin);
    }

    /// <summary>
    /// Dev-only: forces the seeded admin's password back to the dev default and returns a session.
    /// Lets the seeded-admin button in the UI keep working even after the password drifts via
    /// admin-side resets during testing.
    /// </summary>
    public async Task<LoginResult> DevAdminLoginAsync(CancellationToken ct)
    {
        var email = Seeder.DefaultAdminEmail.ToLowerInvariant();
        var user = await _db.Users.IgnoreQueryFilters().FirstOrDefaultAsync(u => u.Email == email, ct);
        if (user is null) return new LoginResult.InvalidCredentials();
        user.PasswordHash = _hasher.Hash(Seeder.DefaultAdminPassword);
        user.EmailVerified = true;
        await _db.SaveChangesAsync(ct);
        return await RefreshAsync(user.Id, ct);
    }

    private string PublicBaseUrl() => _config["App:PublicBaseUrl"] ?? "http://localhost:8088";
}

public abstract record RegistrationResult
{
    public sealed record Created(Guid UserId) : RegistrationResult;
    public sealed record AlreadyExists : RegistrationResult;
}

public abstract record LoginResult
{
    public sealed record Ok(string AccessToken, Guid UserId, bool IsAdmin) : LoginResult;
    public sealed record InvalidCredentials : LoginResult;
    public sealed record EmailNotVerified : LoginResult;
    public sealed record NotApproved(MembershipStatus Status) : LoginResult;
}
