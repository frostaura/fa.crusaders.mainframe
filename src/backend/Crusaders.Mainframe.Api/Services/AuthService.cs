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
    private readonly AccessTokenRevocationList _revocations;
    private readonly InherentAdminService _inherentAdmins;
    private readonly ClubIdentityResolver _club;

    private readonly MemberCodeService _memberCodes;
    private readonly RefreshSessions _refresh;

    public AuthService(MainframeDbContext db, ITenantContext tenant, IPasswordHasher hasher,
        IJwtIssuer jwt, IEmailService email, IConfiguration config, ILogger<AuthService> logger,
        MemberApprovalService memberships, AccessTokenRevocationList revocations,
        InherentAdminService inherentAdmins, ClubIdentityResolver club, MemberCodeService memberCodes,
        RefreshSessions refresh)
    {
        _memberCodes = memberCodes;
        _refresh = refresh;
        _db = db; _tenant = tenant; _hasher = hasher; _jwt = jwt;
        _email = email; _config = config; _logger = logger;
        _memberships = memberships; _revocations = revocations;
        _inherentAdmins = inherentAdmins; _club = club;
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
    private Task SendOrLogAsync(EmailMessage message, string what, CancellationToken ct)
    {
        // Dispatched, not awaited — and this is the other half of the hazard the comment above
        // describes.
        //
        // Swallowing the SMTP exception stopped a FAILED send from returning 500 for an account
        // that had already been created. It did nothing about a SLOW one. The sends still
        // blocked the response, registration raises three of them, and the browser abandons the
        // request at twenty seconds — so a merely sluggish mail server produced the exact
        // outcome this class was written to prevent: "couldn't submit your application",
        // followed on the retry by "that membership number is already registered", for the
        // member's own invisible account. Reproduced against a real SMTP host.
        //
        // EmailDispatch.InBackground is the shape this codebase already uses for the PayFast
        // ITN and the desk's credit adjustment, for the same reason: the ledger is the record,
        // and the mail server is allowed to be slow independently of it.
        //
        // `ct` is deliberately NOT passed on. It is the request's token, and the request is
        // over — honouring it would cancel every one of these sends the instant the member sees
        // their confirmation screen.
        EmailDispatch.InBackground(_email, _logger, message, what);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Removes a photo that was uploaded for a registration that then failed.
    ///
    /// <para>
    /// The browser uploads the selfie before it posts the registration, so every refused
    /// registration used to leave a file on the media volume forever, tied to nobody. The
    /// upload endpoint is anonymous, so that was a write-anything-you-like loop with no
    /// reaper at the end of it.
    /// </para>
    ///
    /// <para>
    /// <b>The referenced-by-nobody check is load-bearing, not tidiness.</b> The URL arrives in
    /// an anonymous request body, so without it an attacker could post a registration carrying
    /// a <i>real member's</i> photo URL and a deliberately-duplicate email, and have us delete
    /// that member's photo on the failure path. Same reason the name is refused if it can walk
    /// out of the tenant's own photo directory.
    /// </para>
    /// </summary>
    private async Task RemoveOrphanedPhotoAsync(string? photoUrl, CancellationToken ct)
    {
        var prefix = $"/uploads/{_tenant.TenantSlug}/photos/";
        if (string.IsNullOrWhiteSpace(photoUrl) || !photoUrl.StartsWith(prefix, StringComparison.Ordinal)) return;

        var name = photoUrl[prefix.Length..];
        if (name.Length == 0 || name.Contains('/') || name.Contains('\\') || name.Contains("..")) return;
        if (await _db.Memberships.IgnoreQueryFilters().AnyAsync(m => m.PhotoUrl == photoUrl, ct)) return;

        try
        {
            var dir = Path.GetFullPath(Path.Combine(_config["Media:StoragePath"] ?? "./media", _tenant.TenantSlug, "photos"));
            var full = Path.GetFullPath(Path.Combine(dir, name));
            if (!full.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return;
            if (File.Exists(full)) File.Delete(full);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not remove orphaned registration photo {Url}", photoUrl);
        }
    }

    public async Task<RegistrationResult> RegisterAsync(string email, string password, string fullName, string membershipNumber, string? photoUrl, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();
        membershipNumber = membershipNumber.Trim();
        if (await _db.Users.AnyAsync(u => u.Email == email, ct))
        {
            await RemoveOrphanedPhotoAsync(photoUrl, ct);
            return new RegistrationResult.AlreadyExists();
        }

        // Checked here rather than left to the unique index. It was left to the index, and the
        // index did its job: 23505 out of SaveChangesAsync, an unhandled 500 carrying the whole
        // EF exception, and a screen telling the applicant to "Try again" — advice that could
        // never work. Membership numbers are club-issued and mistyping a digit onto somebody
        // else's is an ordinary human error, not an edge case.
        if (await _db.Memberships.AnyAsync(m => m.MembershipNumber == membershipNumber, ct))
        {
            await RemoveOrphanedPhotoAsync(photoUrl, ct);
            return new RegistrationResult.MembershipNumberInUse();
        }

        // IsAdmin stays false here even for an address in Admins:Emails, and that is a decision
        // rather than an omission. An applicant at this moment has an unconfirmed address and a
        // membership the club has not approved; IsAdmin is precisely what exempts an account
        // from both of those checks in LoginAsync, so setting it here would let a configured
        // address sign straight past them. An inherent administrator who registers after the
        // stack was deployed is promoted at their first sign-in that passes every check — see
        // InherentAdminService, which explains why that is the earliest safe moment.
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

        // The club's admins are told through the outbox, staged in THIS save (R23). It used to
        // be a loop of background sends after the commit, and a process that died in between —
        // or a mail server that refused one address — lost the only cue the desk gets that
        // somebody is waiting. Rolled back with everything else on the duplicate paths below.
        AdminNotices.Stage(_db, _tenant.TenantId,
            AdminNotices.MemberRegistered(user.Id, fullName, email, membershipNumber));

        // The pre-checks above close the ordinary case; this closes the race between two
        // applicants claiming the same number in the same second. Same answer either way, so
        // the caller never has to know which one it was.
        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            _db.ChangeTracker.Clear();
            await RemoveOrphanedPhotoAsync(photoUrl, ct);
            return await _db.Users.AnyAsync(u => u.Email == email, ct)
                ? new RegistrationResult.AlreadyExists()
                : new RegistrationResult.MembershipNumberInUse();
        }

        // ONE mail to the applicant, not two.
        //
        // This sent a "pending review" notice beside the verification link, in the same second,
        // while the screen in front of them said they had been sent A link and that the next
        // message would come when the club approved them. The approval mail was therefore the
        // third, and for a reader who is not confident with software a count that does not
        // match is not a detail — it reads as something having gone wrong. The pending notice
        // also carried no link at all, so an applicant who opened it first was told to wait by
        // the one of the two whose job was to tell them to press something.
        //
        // VerifyEmail now says both things in the order they happen, which is the order the
        // registration screen already promises. MembershipPending is gone rather than unused.
        var verifyUrl = $"{PublicBaseUrl()}/verify-email/{token}";
        var club = await _club.GetAsync(ct);
        await SendOrLogAsync(EmailTemplates.VerifyEmail(club, email, verifyUrl), $"verification for {email}", ct);
        // ONE call, and it is this one. Two fixers closed spec §2.3 independently — a private
        // helper here and MemberApprovalService.AnnounceRegistrationAsync — and the merge left
        // both live, so every application put two near-identical emails in front of the club's
        // desk. The service is the survivor because it also emits `member.registered`, which a
        // private helper in the auth path had no business doing.
        await _memberships.AnnounceRegistrationAsync(user.Id, ct);

        return new RegistrationResult.Created(user.Id);
    }

    /// <summary>
    /// True for a unique-index violation, whichever provider raised it.
    ///
    /// <para>
    /// Npgsql reports SQLSTATE 23505; the in-memory provider used by most of the suite enforces
    /// no index at all and never gets here. Matched on the SQLSTATE rather than on the exception
    /// type so this file does not have to reference the driver.
    /// </para>
    /// </summary>
    private static bool IsUniqueViolation(DbUpdateException ex)
    {
        for (Exception? e = ex; e is not null; e = e.InnerException)
        {
            var sqlState = e.GetType().GetProperty("SqlState")?.GetValue(e) as string;
            if (sqlState == "23505") return true;
        }
        return false;
    }

    /// <summary>
    /// Re-sends the address-confirmation email, if there is anything to re-send.
    ///
    /// <para>
    /// Always reports success. An honest answer here would say whether an address is registered
    /// and whether it is verified — a free account-enumeration oracle on an anonymous,
    /// rate-limited endpoint. The caller learns nothing; the person who owns the mailbox gets
    /// the link.
    /// </para>
    ///
    /// <para>
    /// Any earlier unused verification token is spent first, so a member who asks twice cannot
    /// end up with two live links to the same account.
    /// </para>
    /// </summary>
    public async Task ResendVerificationAsync(string email, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Email == email, ct);
        if (user is null || user.EmailVerified) return;

        var stale = await _db.AuthTokens
            .Where(t => t.UserId == user.Id && t.Kind == TokenKind.EmailVerification && t.UsedAt == null)
            .ToListAsync(ct);
        foreach (var t in stale) t.UsedAt = DateTimeOffset.UtcNow;

        var token = TokenHashing.Generate();
        _db.AuthTokens.Add(new AuthToken
        {
            TenantId = user.TenantId,
            UserId = user.Id,
            Kind = TokenKind.EmailVerification,
            TokenHash = TokenHashing.Hash(token),
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(24),
        });
        await _db.SaveChangesAsync(ct);

        await SendOrLogAsync(
            EmailTemplates.VerifyEmail(await _club.GetAsync(ct), user.Email, $"{PublicBaseUrl()}/verify-email/{token}"),
            $"re-sent verification for {user.Email}", ct);
    }

    /// <summary>
    /// Changes the signed-in user's own password, and in doing so retires any temporary one.
    ///
    /// <para>
    /// This is the only way <see cref="User.MustChangePassword"/> is ever cleared, which is what
    /// makes an admin-issued temporary password actually temporary: it stops working at the
    /// moment it is replaced, and until then it unlocks nothing but this call.
    /// </para>
    /// </summary>
    public async Task<PasswordChangeResult> ChangePasswordAsync(Guid userId, string currentPassword, string newPassword, CancellationToken ct) =>
        (await ChangePasswordAndReissueAsync(userId, currentPassword, newPassword, ct)).Result;

    /// <summary>
    /// <see cref="ChangePasswordAsync"/>, plus a fresh access token for the session that asked.
    ///
    /// <para>
    /// The change is a rotation (member-code §10), and a rotation ends every session minted
    /// before it — <see cref="User.SessionEpoch"/> — including the one making this call.
    /// That is right for every OTHER session (whoever learned the old password may be signed in
    /// somewhere) and wrong for the member at the keyboard, who would be signed out for doing
    /// the responsible thing. So the caller is handed a token minted after the cut-off and
    /// keeps its session; the token it presented stops working.
    /// </para>
    /// </summary>
    public async Task<(PasswordChangeResult Result, string? AccessToken, int SessionEpoch)> ChangePasswordAndReissueAsync(
        Guid userId, string currentPassword, string newPassword, CancellationToken ct)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null || user.PasswordHash is null) return (PasswordChangeResult.NoPasswordSet, null, 0);
        if (!_hasher.Verify(currentPassword, user.PasswordHash)) return (PasswordChangeResult.CurrentPasswordWrong, null, 0);
        if (_hasher.Verify(newPassword, user.PasswordHash)) return (PasswordChangeResult.Unchanged, null, 0);

        user.PasswordHash = _hasher.Hash(newPassword);
        user.MustChangePassword = false;
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = user.TenantId,
            ActorUserId = user.Id,
            SubjectUserId = user.Id,
            Action = "user.password_changed",
        });

        // A new password retires the member's code and every open session (member-code §10):
        // whoever learned the old password may have enrolled a phone with it, or be signed in.
        // Staged, so both commit together.
        await _memberCodes.StageRotationAsync(user.Id, user.Id, "password_changed", ct);
        await _db.SaveChangesAsync(ct);
        await _memberCodes.CompleteRotationsAsync(ct);

        await SendOrLogAsync(EmailTemplates.PasswordChanged(await _club.GetAsync(ct), user.Email), $"password-changed notice for {user.Email}", ct);

        // Minted under the epoch the rotation just raised, so it is the one session that survives it.
        return (PasswordChangeResult.Ok, _jwt.IssueAccess(user.Id, user.TenantId, _tenant.TenantSlug, RolesOf(user), user.SessionEpoch), user.SessionEpoch);
    }

    private static List<string> RolesOf(User user)
    {
        var roles = new List<string>();
        if (user.IsAdmin) roles.Add("admin");
        if (user.IsPlatformAdmin) roles.Add("platform_admin");
        return roles;
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

        if (!_tenant.IsResolved)
        {
            var tenant = await _db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == user.TenantId, ct);
            _tenant.Set(tenant.Id, tenant.Slug);
        }

        var membership = await _db.Memberships.IgnoreQueryFilters().FirstOrDefaultAsync(m => m.UserId == user.Id, ct);
        var decided = membership is not null && !user.IsAdmin
            && membership.Status is MembershipStatus.Rejected or MembershipStatus.Suspended;
        // A decision the club has already taken outranks an unconfirmed address.
        //
        // Verification used to be checked first for everybody, so a rejected applicant who had
        // never clicked the verify link was told to go and confirm their email — and the screen
        // offered the resend to go with it. That is a repair for a problem they do not have,
        // ending at a screen saying an admin will review their application; the review had
        // already happened and it was a refusal. Confirming an address cannot change a rejection
        // or lift a suspension, so those two are reported as what they are, whatever the address
        // is doing. A PENDING applicant is the opposite case — verifying is exactly what they
        // still owe — so that order is unchanged.
        if (decided) return new LoginResult.NotApproved(membership!.Status);
        if (!user.EmailVerified) return new LoginResult.EmailNotVerified();
        if (membership is not null && membership.Status != MembershipStatus.Active && !user.IsAdmin)
            return new LoginResult.NotApproved(membership.Status);

        user.LastLoginAt = DateTimeOffset.UtcNow;

        // THE LAST THING, AND THE POSITION IS THE WHOLE SAFETY ARGUMENT.
        //
        // Admins:Emails decides one bit — IsAdmin — and it must not be able to decide any
        // other. This method already treats IsAdmin as an EXEMPTION from the membership gate
        // eleven lines above ("!user.IsAdmin"), so a promotion applied any earlier would let a
        // configured address in past a rejection, a suspension or an unapproved application
        // that the club itself had decided. Applied here, every refusal has already been
        // evaluated against the account as the database found it: the list can only add the
        // admin flag to a sign-in that was going to succeed anyway.
        //
        // The same reasoning is why RegisterAsync does not call this and ConsumeMagicLinkAsync
        // does not either — see InherentAdminService.
        await _inherentAdmins.ApplyAsync(user, ct);
        await _db.SaveChangesAsync(ct);

        var roles = new List<string>();
        if (user.IsAdmin) roles.Add("admin");
        if (user.IsPlatformAdmin) roles.Add("platform_admin");

        var token = _jwt.IssueAccess(user.Id, _tenant.TenantId, _tenant.TenantSlug, roles, user.SessionEpoch);
        return new LoginResult.Ok(token, user.Id, user.IsAdmin, user.MustChangePassword, user.SessionEpoch);
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
        await SendOrLogAsync(EmailTemplates.PasswordReset(await _club.GetAsync(ct), email, resetUrl), $"password reset for {email}", ct);
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
        // The member has just chosen this one themselves, so whatever an admin issued before it
        // is retired and the forced-change gate has nothing left to enforce.
        user.MustChangePassword = false;
        record.UsedAt = DateTimeOffset.UtcNow;
        await _memberCodes.StageRotationAsync(user.Id, user.Id, "password_reset", ct);
        await _db.SaveChangesAsync(ct);
        await _memberCodes.CompleteRotationsAsync(ct);

        // Spec §11 and §3: every successful password change emails the member, "the one signal a
        // member has that somebody else changed it". Only the admin-issued and self-service
        // paths were sending it; the reset path — the one a stolen or forwarded reset link
        // travels — changed the password and told nobody. The reset mail itself is not that
        // signal: it is sent before anything happens, and it is the mail an attacker with
        // mailbox access has already read.
        await SendOrLogAsync(EmailTemplates.PasswordChanged(await _club.GetAsync(ct), user.Email), $"password-changed notice for {user.Email}", ct);
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
        // Consuming a link that was emailed to the address IS proof of control of the address.
        //
        // Email verification used to be enforced on the password ingress and silently skipped
        // here, so an approved member who never clicked the verify link was refused at sign-in
        // (and told, wrongly, that they were not approved) while the welcome link let them
        // straight in. One of the two had to give; refusing the ingress that carries the proof
        // would have been the wrong one.
        user.EmailVerified = true;
        await _db.SaveChangesAsync(ct);

        var roles = new List<string>();
        if (user.IsAdmin) roles.Add("admin");
        var jwt = _jwt.IssueAccess(user.Id, _tenant.TenantId, _tenant.TenantSlug, roles, user.SessionEpoch);
        return new LoginResult.Ok(jwt, user.Id, user.IsAdmin, user.MustChangePassword, user.SessionEpoch);
    }

    /// <summary>
    /// Re-mints an access token for a session that already holds a valid one.
    /// </summary>
    /// <remarks>
    /// It applies the same membership test as <see cref="LoginAsync"/>, and that is the whole
    /// point of it doing more than re-signing a claim set. The app refreshes on a timer for as
    /// long as a tab is open, so without the test a member suspended at the desk kept renewing
    /// a full session indefinitely — reading their wallet, their ledger and the schedule —
    /// while the sign-in screen correctly refused them. Suspension has to end the session that
    /// is already open, not only the next one.
    /// </remarks>
    public async Task<LoginResult> RefreshAsync(Guid userId, int presentedEpoch, CancellationToken ct)
    {
        var user = await _db.Users.IgnoreQueryFilters().FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return new LoginResult.InvalidCredentials();

        // Read from the row, never the session cache: a refresh re-mints a token, so a session a
        // rotation ended must not be renewed inside the cache's fifteen seconds either. The new
        // token carries the epoch READ HERE — so a refresh racing a rotation mints a token that
        // is either already below the incremented epoch or was never old (member-code §10,
        // SessionEpochs).
        if (presentedEpoch < user.SessionEpoch) return new LoginResult.InvalidCredentials();
        if (!_tenant.IsResolved)
        {
            var tenant = await _db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == user.TenantId, ct);
            _tenant.Set(tenant.Id, tenant.Slug);
        }
        var membership = await _db.Memberships.IgnoreQueryFilters().FirstOrDefaultAsync(m => m.UserId == user.Id, ct);
        if (membership is not null && membership.Status != MembershipStatus.Active && !user.IsAdmin)
            return new LoginResult.NotApproved(membership.Status);
        var roles = new List<string>();
        if (user.IsAdmin) roles.Add("admin");
        if (user.IsPlatformAdmin) roles.Add("platform_admin");
        var token = _jwt.IssueAccess(user.Id, _tenant.TenantId, _tenant.TenantSlug, roles, user.SessionEpoch);
        return new LoginResult.Ok(token, user.Id, user.IsAdmin, user.MustChangePassword, user.SessionEpoch);
    }

    /// <summary>
    /// Exchanges the refresh cookie for a new access token and the link's successor (B1).
    ///
    /// <para>
    /// The link is SPENT first (<see cref="RefreshSessions.ClaimAsync"/>), then the same test a
    /// bearer refresh applies runs against the account — epoch not raised since the link was
    /// issued, membership still active — so a suspended member or a rotated account gets nothing,
    /// and its family is revoked rather than left for the next presentation. The successor carries
    /// the epoch the new access token was minted under, READ HERE: a rotation racing this exchange
    /// leaves both below the account's epoch, never above it.
    /// </para>
    /// </summary>
    public async Task<CookieRefresh> RefreshWithCookieAsync(string? cookie, CancellationToken ct)
    {
        if (!_tenant.IsResolved) return new CookieRefresh(new LoginResult.InvalidCredentials(), null);

        var claim = await _refresh.ClaimAsync(cookie, _tenant.TenantId, ct);
        if (claim is not RefreshClaim.Claimed { Row: var row })
        {
            return new CookieRefresh(new LoginResult.InvalidCredentials(), null, claim is RefreshClaim.Superseded);
        }

        var result = await RefreshAsync(row.UserId, row.SessionEpoch, ct);
        if (result is not LoginResult.Ok ok)
        {
            await _refresh.RevokeFamilyAsync(row.TenantId, row.FamilyId, ct);
            return new CookieRefresh(result, null);
        }

        var successor = await _refresh.IssueAsync(row.TenantId, row.UserId, ok.SessionEpoch, row.FamilyId, ct);
        return new CookieRefresh(ok, successor);
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
        // The dev shortcut hands out a known password on purpose; it must not then trap the
        // session behind the forced-change gate a previous admin-side reset may have armed.
        user.MustChangePassword = false;
        await _db.SaveChangesAsync(ct);
        return await RefreshAsync(user.Id, user.SessionEpoch, ct);
    }

    /// <summary>
    /// Signs one access token out, for real.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Deleting the client's copy is not a sign-out — a JWT is a bearer credential and stays
    /// valid wherever else it reached. The token is put on the in-process revocation list so
    /// the next request carrying it is refused, and written to <c>auth_tokens</c> so a restart
    /// inside its remaining lifetime does not bring it back.
    /// </para>
    /// <para>
    /// Idempotent by design: signing out twice, or signing out a token already recorded, is a
    /// no-op rather than an error. There is nothing a member gains by being told which.
    /// </para>
    /// </remarks>
    public async Task RevokeAccessTokenAsync(Guid userId, string jti, DateTimeOffset expiresAt, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(jti)) return;
        _revocations.Revoke(jti, expiresAt);

        var hash = TokenHashing.Hash(jti);
        var already = await _db.AuthTokens.IgnoreQueryFilters()
            .AnyAsync(t => t.TokenHash == hash && t.Kind == TokenKind.RevokedAccess, ct);
        if (already) return;

        _db.AuthTokens.Add(new AuthToken
        {
            TenantId = _tenant.IsResolved ? _tenant.TenantId : Guid.Empty,
            UserId = userId,
            Kind = TokenKind.RevokedAccess,
            TokenHash = hash,
            ExpiresAt = expiresAt,
        });
        await _db.SaveChangesAsync(ct);
    }

    private string PublicBaseUrl() => _config["App:PublicBaseUrl"] ?? "http://localhost:8088";
}

public abstract record RegistrationResult
{
    public sealed record Created(Guid UserId) : RegistrationResult;
    public sealed record AlreadyExists : RegistrationResult;

    /// <summary>The (tenant, membership number) pair is taken. Its own case, not a 500.</summary>
    public sealed record MembershipNumberInUse : RegistrationResult;
}

/// <summary>Outcome of a member changing their own password.</summary>
public enum PasswordChangeResult
{
    Ok,
    CurrentPasswordWrong,

    /// <summary>The new password is the current one. Refused, so a forced change is a real change.</summary>
    Unchanged,

    /// <summary>The account has no password at all — passkey-only, or never set one.</summary>
    NoPasswordSet,
}

/// <summary>
/// A cookie refresh's outcome, and the successor link to set when it succeeded.
/// <paramref name="Superseded"/>: the link was spent a moment ago by a concurrent request — the
/// browser's cookie jar already holds (or is about to hold) the successor, so the refusal must
/// NOT clear the cookie.
/// </summary>
public sealed record CookieRefresh(LoginResult Result, IssuedRefresh? Successor, bool Superseded = false);

public abstract record LoginResult
{
    /// <param name="SessionEpoch">The epoch the access token was minted under — a refresh link issued beside it carries the same.</param>
    public sealed record Ok(string AccessToken, Guid UserId, bool IsAdmin, bool MustChangePassword = false, int SessionEpoch = 0) : LoginResult;
    public sealed record InvalidCredentials : LoginResult;
    public sealed record EmailNotVerified : LoginResult;
    public sealed record NotApproved(MembershipStatus Status) : LoginResult;
}
