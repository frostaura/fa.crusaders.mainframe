using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// Creates the minimum set of rows a production deployment needs in order to be usable at all:
/// one tenant, its settings row, one admin who must change their password, and the club's courts.
///
/// <para>
/// This exists because there was no way to do it. <see cref="Seeder"/> runs only under
/// <c>IsDevelopment()</c>, and its doc comment sent operators to a "platform-admin onboarding
/// wizard" that was never built — <c>MainframeDbContext</c> says in as many words that the
/// <c>/api/v1/platform/</c> endpoints it would live behind are not mapped. So a production stack
/// came up against an empty database with no tenant row, and
/// <see cref="TenantResolutionMiddleware"/> answered <c>404 tenant_not_found</c> to every
/// tenant-scoped request. Not a degraded product: no register, no sign-in, nothing. The club's
/// first deployment at crusaders.frostaura.net failed exactly this way, and the register screen
/// blamed the member's internet connection for it.
/// </para>
///
/// <para>
/// It is deliberately NOT <see cref="Seeder"/> with the environment check removed. That seeder is
/// a development fixture: it writes five invented members (Naledi Khoza, Liam O'Connor, …) with
/// R500 opening balances and a fortnight of sample bookings, and it stamps a published,
/// hardcoded admin password back onto the admin row on every single boot. Running it against a
/// real club would put fake people in the members list, fake money in the ledger, and a known
/// credential on the admin account — and keep restoring all of it after anyone cleaned up.
/// </para>
///
/// <para>
/// Everything here is idempotent and additive: it creates what is missing and never modifies or
/// deletes what is already there. Running it on every boot is the intended mode.
/// </para>
/// </summary>
public static class ProductionBootstrap
{
    /// <summary>
    /// Minimum length for the bootstrap admin password.
    ///
    /// <para>
    /// Higher than the 8 characters members are held to, because this credential is created from
    /// a compose file rather than chosen by a person, it is an admin, and it exists before
    /// anyone can be emailed about it. It is a one-time value — <see cref="User.MustChangePassword"/>
    /// is set, so <c>PasswordChangeGate</c> forces a rotation at first sign-in.
    /// </para>
    /// </summary>
    public const int MinimumAdminPasswordLength = 12;

    /// <summary>
    /// Passwords that are long enough to pass the length check and still unacceptable. These are
    /// the ones an operator reaches for when a compose comment says "at least 12 characters".
    /// </summary>
    private static readonly string[] RefusedAdminPasswords =
    {
        "changemeonfirstlogin!", "changeme1234", "password1234", "administrator",
        "crusaders123", "changemeplease", "letmein12345",
    };

    /// <summary>
    /// Settings document written for a brand-new tenant.
    ///
    /// <para>
    /// Deliberately almost empty. <c>TenantSettingsAccessor</c> hard-defaults every operational
    /// number it reads, so an absent key is a working default rather than a hole — which means the
    /// honest thing to write is only what is genuinely club-specific. The development seeder
    /// writes a full document including
    /// <c>"merchant_id": "REPLACE_WITH_PAYFAST_MERCHANT_ID"</c>; copying that here would hand a
    /// real club a payment configuration that looks present and cannot work.
    /// </para>
    /// </summary>
    /// <remarks>
    /// The accent is the club's crest blue, not the #7AB07A that docs/specs/design-system.md
    /// used to call "the Crusaders green" — that measures 2.52:1 on white and can carry
    /// neither text nor a focus ring. Note that nothing reads this key today; it is written so
    /// the row is honest about the club when something finally does.
    /// </remarks>
    private const string InitialSettingsJson = """
        {
          "timezone": "Africa/Johannesburg",
          "brand_accent_hex": "#00498D"
        }
        """;

    /// <summary>
    /// Reads <c>Bootstrap:*</c> and creates whatever is missing. No-op unless
    /// <c>Bootstrap:Enabled</c> is true.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// Thrown when bootstrap is enabled but its configuration cannot produce a safe result. This
    /// stops the container rather than letting it come up half-configured: a stack that boots
    /// "successfully" into an unusable state is the failure mode this whole type exists to
    /// remove, and reproducing it here with a warning would be choosing it again.
    /// </exception>
    public static async Task RunAsync(IServiceProvider services, IConfiguration config, ILogger logger)
    {
        if (!config.GetValue<bool>("Bootstrap:Enabled"))
        {
            logger.LogDebug("Bootstrap:Enabled is not true — skipping first-run bootstrap.");
            return;
        }

        var slug = (config["Bootstrap:TenantSlug"] ?? "").Trim().ToLowerInvariant();
        var displayName = (config["Bootstrap:TenantDisplayName"] ?? "").Trim();
        var adminEmail = (config["Bootstrap:AdminEmail"] ?? "").Trim().ToLowerInvariant();
        var adminPassword = config["Bootstrap:AdminPassword"] ?? "";
        var courtCount = config.GetValue("Bootstrap:Courts", 4);
        // Must be > 0. Court.SlicePriceCredits defaults to 0m and each court carries its OWN
        // price — AdminConfigEndpoints reads court.SlicePriceCredits, not the tenant setting,
        // when it charges a booking. Courts created without this are free to book, silently and
        // for as long as nobody checks the ledger. The default matches the accessor's
        // slice_price_credits fallback so a bootstrapped club and a configured one agree.
        var slicePriceCredits = config.GetValue("Bootstrap:SlicePriceCredits", 8m);

        Validate(slug, displayName, adminEmail, adminPassword, courtCount, slicePriceCredits);

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();

        var created = new List<string>();

        // IgnoreQueryFilters throughout the tenant lookup: we are operating above tenancy, and
        // the filter would otherwise scope the search to the empty tenant we have not set yet.
        var tenant = await db.Tenants.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Slug == slug);
        if (tenant is null)
        {
            tenant = new Tenant { Slug = slug, DisplayName = displayName, Status = "active" };
            db.Tenants.Add(tenant);
            db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = InitialSettingsJson });
            await db.SaveChangesAsync();
            created.Add($"tenant '{slug}'");
        }
        else if (await db.TenantSettings.IgnoreQueryFilters().AllAsync(s => s.TenantId != tenant.Id))
        {
            // A tenant with no settings row reads as "{}" and therefore works, but every write
            // through the admin settings screen assumes the row exists. Cheap to repair here.
            db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = InitialSettingsJson });
            await db.SaveChangesAsync();
            created.Add("tenant settings row");
        }

        tenantContext.Set(tenant.Id, tenant.Slug);

        var admin = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.TenantId == tenant.Id && u.Email == adminEmail);

        // Does the club already have an admin under some OTHER address?
        //
        // This is the case that crashed the container. The lookup above is by email, so
        // changing Bootstrap__AdminEmail — correcting a typo, moving to a shared committee
        // mailbox — found nothing and fell through to creating a second admin, whose
        // membership row carried the same hardcoded ADMIN-0001. That collides with the unique
        // index on (TenantId, MembershipNumber), the exception escapes startup, and the stack
        // then fails to boot on EVERY restart. An operator fixing a typo bricked their club,
        // and the only way back was to edit the database or guess the old address.
        //
        // Standing up the club's first admin is this type's whole job. A second one is the
        // admin console's, so say so and carry on rather than half-creating one.
        var existingAdmin = admin is null
            ? await db.Users.IgnoreQueryFilters()
                .Where(u => u.TenantId == tenant.Id && u.IsAdmin)
                .Select(u => u.Email)
                .FirstOrDefaultAsync()
            : null;

        if (admin is null && existingAdmin is not null)
        {
            logger.LogWarning(
                "Bootstrap: Bootstrap__AdminEmail is '{Wanted}' but this club already has an admin, '{Existing}'. " +
                "Leaving it alone — add or change admins from Admin → Members, not from the compose file.",
                adminEmail, existingAdmin);
        }
        else if (admin is null)
        {
            admin = new User
            {
                TenantId = tenant.Id,
                Email = adminEmail,
                PasswordHash = hasher.Hash(adminPassword),
                EmailVerified = true,
                IsAdmin = true,
                Status = "active",
                // The compose file holding this password is readable by anyone who can see the
                // Portainer stack, and it travels in plain text to whoever set it up. It is a
                // delivery mechanism, not a credential.
                MustChangePassword = true,
            };
            db.Users.Add(admin);
            db.Memberships.Add(new Membership
            {
                TenantId = tenant.Id,
                UserId = admin.Id,
                FullName = displayName + " Admin",
                // Defence in depth behind the check above. The number only has to be unique
                // within the tenant and is not meaningful to anybody, so take the first free
                // one rather than asserting that ADMIN-0001 must be available.
                MembershipNumber = await FreeAdminNumberAsync(db, tenant.Id),
                Status = MembershipStatus.Active,
            });
            await db.SaveChangesAsync();
            created.Add($"admin '{adminEmail}' (must change password at first sign-in)");
        }
        // No else. An existing admin is left exactly as it is — password included. The
        // development seeder re-stamps its hardcoded password onto a drifted admin on every
        // boot; doing that here would silently revert a rotation the club had just performed,
        // and would keep the compose file's password live forever.

        if (!await db.Courts.IgnoreQueryFilters().AnyAsync(c => c.TenantId == tenant.Id))
        {
            for (var i = 1; i <= courtCount; i++)
            {
                db.Courts.Add(new Court
                {
                    TenantId = tenant.Id,
                    CourtNumber = i,
                    Name = $"Court {i}",
                    CourtType = CourtType.Squash,
                    SlicePriceCredits = slicePriceCredits,
                });
            }
            await db.SaveChangesAsync();
            created.Add($"{courtCount} squash court(s) at {slicePriceCredits} credits/slice");
        }

        if (created.Count == 0)
        {
            logger.LogInformation("Bootstrap: nothing to do — tenant '{Slug}' is already set up.", slug);
        }
        else
        {
            logger.LogWarning(
                "Bootstrap created: {Created}. Sign in as {Email} and change the password immediately, " +
                "then set Bootstrap__Enabled=false.",
                string.Join(", ", created), adminEmail);
        }
    }

    /// <summary>
    /// The first ADMIN-nnnn membership number not already taken in this tenant.
    /// </summary>
    private static async Task<string> FreeAdminNumberAsync(MainframeDbContext db, Guid tenantId)
    {
        var taken = await db.Memberships.IgnoreQueryFilters()
            .Where(m => m.TenantId == tenantId && m.MembershipNumber.StartsWith("ADMIN-"))
            .Select(m => m.MembershipNumber)
            .ToListAsync();

        for (var i = 1; i <= 999; i++)
        {
            var candidate = $"ADMIN-{i:D4}";
            if (!taken.Contains(candidate)) return candidate;
        }

        throw new InvalidOperationException(
            "Bootstrap could not find a free ADMIN-nnnn membership number, which means this club has 999 of them. " +
            "That is not a situation the first-run bootstrap should be resolving.");
    }

    /// <summary>
    /// Every way the configuration can be wrong, reported together rather than one boot at a time.
    /// </summary>
    private static void Validate(string slug, string displayName, string adminEmail, string adminPassword, int courtCount, decimal slicePriceCredits)
    {
        var problems = new List<string>();

        if (string.IsNullOrWhiteSpace(slug))
            problems.Add("Bootstrap__TenantSlug is required (e.g. 'crusaders'). It must equal the first label of the hostname members use, because TenantResolutionMiddleware derives the tenant from that subdomain.");
        else if (!slug.All(c => char.IsAsciiLetterOrDigit(c) || c == '-'))
            problems.Add($"Bootstrap__TenantSlug '{slug}' may contain only letters, digits and hyphens.");

        if (string.IsNullOrWhiteSpace(displayName))
            problems.Add("Bootstrap__TenantDisplayName is required (e.g. 'Crusaders Squash Club').");

        if (string.IsNullOrWhiteSpace(adminEmail))
            problems.Add("Bootstrap__AdminEmail is required.");
        else if (!adminEmail.Contains('@') || adminEmail.StartsWith('@') || adminEmail.EndsWith('@'))
            problems.Add($"Bootstrap__AdminEmail '{adminEmail}' is not an email address.");

        if (string.IsNullOrWhiteSpace(adminPassword))
            problems.Add($"Bootstrap__AdminPassword is required and must be at least {MinimumAdminPasswordLength} characters.");
        else if (adminPassword.Length < MinimumAdminPasswordLength)
            problems.Add($"Bootstrap__AdminPassword must be at least {MinimumAdminPasswordLength} characters (got {adminPassword.Length}).");
        else if (RefusedAdminPasswords.Contains(adminPassword.ToLowerInvariant()))
            problems.Add("Bootstrap__AdminPassword is one of the placeholder passwords this project has shipped before. Choose a real one.");

        if (courtCount is < 1 or > 64)
            problems.Add($"Bootstrap__Courts must be between 1 and 64 (got {courtCount}).");

        if (slicePriceCredits <= 0m)
            problems.Add($"Bootstrap__SlicePriceCredits must be greater than 0 (got {slicePriceCredits}). Courts created at 0 are free to book.");

        if (problems.Count == 0) return;

        throw new InvalidOperationException(
            "Bootstrap__Enabled is true but the bootstrap configuration is not usable, so the API is " +
            "refusing to start rather than coming up without a tenant:" +
            string.Concat(problems.Select(p => "\n  - " + p)));
    }
}
