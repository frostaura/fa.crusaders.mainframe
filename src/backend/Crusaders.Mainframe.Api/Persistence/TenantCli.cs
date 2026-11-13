using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The operator's tool for the clubs on a deployment (BP-07): create one, list them, suspend or
/// reopen one, and set its address. Run inside the backend container:
/// <code>docker compose exec backend dotnet Crusaders.Mainframe.Api.dll tenant &lt;command&gt; [options]</code>
///
/// <para>
/// <b>Why a command and not an HTTP API.</b> Onboarding a second club needed raw SQL: no route
/// created a tenant and <see cref="Tenant.Status"/> was read by nothing. (A club's PayFast
/// account is its own admins' to set, in the console — not the operator's.) An HTTP surface for this would be an account above every club — the
/// <c>platform_admin</c> role this codebase minted for years and never checked — reachable from the
/// internet and worth more than any one club's admin. A command run in the container is reachable
/// only by whoever can already run commands in the container, which is the operator and nobody
/// else, and it needs no credential of its own.
/// </para>
///
/// <para>
/// <b>Nobody is handed a password.</b> <c>create</c> makes the club's first admin with no password
/// and queues a mail whose link sets one (a password-reset token, <see cref="AdminLinkHours"/>
/// hours) — consuming it also proves the address. <c>--print-link</c> prints the link as well, for
/// a deployment whose mail is not working yet; the link is a credential, so only on request.
/// </para>
///
/// <para>
/// Every command is idempotent where it can be (suspending a suspended club is a no-op that says
/// so) and refuses rather than guesses where it cannot (an existing slug, an address that would
/// not resolve back to the club).
/// </para>
/// </summary>
public static class TenantCli
{
    /// <summary>How long the first admin's set-your-password link lasts.</summary>
    public const int AdminLinkHours = 72;

    public const int Ok = 0, Failed = 1, Usage = 2;

    private const string UsageText = """
        usage: dotnet Crusaders.Mainframe.Api.dll tenant <command> [options]

          list
          create   --slug <slug> --name "<club name>" --admin-email <address>
                   [--courts <1-64, default 4>] [--timezone <IANA zone, default Africa/Johannesburg>]
                   [--public-base-url <https://slug.example.net>] [--print-link]
          suspend  --slug <slug>
          activate --slug <slug>
          set-url  --slug <slug> (--public-base-url <url> | --clear)
        """;

    /// <summary>True when the process was started to run a command rather than to serve.</summary>
    public static bool IsCommand(string[] args) => args.Length > 0 && args[0] == "tenant";

    /// <summary>Runs one command and answers the process exit code.</summary>
    public static async Task<int> RunAsync(IServiceProvider services, string[] args, TextWriter output, CancellationToken ct = default)
    {
        if (args.Length < 2) return Fail(output, UsageText, Usage);
        var options = Options.Parse(args.Skip(2).ToArray());
        if (options is null) return Fail(output, UsageText, Usage);

        using var scope = services.CreateScope();
        var context = new CliContext(scope.ServiceProvider, options, output);
        return args[1] switch
        {
            "list" => await ListAsync(context, ct),
            "create" => await CreateAsync(context, ct),
            "suspend" => await SetStatusAsync(context, TenantStatus.Suspended, ct),
            "activate" => await SetStatusAsync(context, TenantStatus.Active, ct),
            "set-url" => await SetUrlAsync(context, ct),
            _ => Fail(output, UsageText, Usage),
        };
    }

    private sealed record CliContext(IServiceProvider Services, Options Options, TextWriter Output)
    {
        public MainframeDbContext Db => Services.GetRequiredService<MainframeDbContext>();
        public IConfiguration Config => Services.GetRequiredService<IConfiguration>();
    }

    private static async Task<int> ListAsync(CliContext c, CancellationToken ct)
    {
        var clubs = await c.Db.Tenants.IgnoreQueryFilters().AsNoTracking()
            .Where(t => t.DemoOfTenantId == null)
            .OrderBy(t => t.CreatedAt)
            .Select(t => new { t.Id, t.Slug, t.DisplayName, t.Status, t.PublicBaseUrl })
            .ToListAsync(ct);
        foreach (var t in clubs)
        {
            var members = await c.Db.Memberships.IgnoreQueryFilters().CountAsync(m => m.TenantId == t.Id, ct);
            c.Output.WriteLine(string.Create(CultureInfo.InvariantCulture,
                $"{t.Slug}\t{t.Status}\t{members} member(s)\t{TenantLinks.Resolve(c.Config, t.Slug, t.PublicBaseUrl)}\t{t.DisplayName}"));
        }

        if (clubs.Count == 0) c.Output.WriteLine("No clubs on this deployment.");
        return Ok;
    }

    private static async Task<int> CreateAsync(CliContext c, CancellationToken ct)
    {
        if (CreatePlan.From(c.Options, c.Config) is not { } plan) return Fail(c.Output, UsageText, Usage);
        if (plan.Problems.Count > 0) return Fail(c.Output, "tenant create refused:\n  - " + string.Join("\n  - ", plan.Problems), Failed);

        var db = c.Db;
        if (await db.Tenants.IgnoreQueryFilters().AnyAsync(t => t.Slug == plan.Slug, ct))
        {
            return Fail(c.Output, $"tenant create refused: a club with the slug '{plan.Slug}' already exists.", Failed);
        }

        await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
        var tenant = new Tenant
        {
            Slug = plan.Slug,
            DisplayName = plan.Name,
            Status = TenantStatus.Active,
            PublicBaseUrl = plan.PublicBaseUrl,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = InitialSettings(plan.Timezone),
        });
        await db.SaveChangesAsync(ct);
        c.Services.GetRequiredService<ITenantContext>().Set(tenant.Id, tenant.Slug);

        await MemberGroupSeeder.EnsureAsync(db, tenant.Id, ct);
        await ProductionBootstrap.AddCourtsAsync(db, tenant.Id, plan.Courts);
        await MinutePackageSeeder.EnsureAsync(db, tenant.Id, Guid.Empty, ct);
        var token = await AddFirstAdminAsync(db, tenant, plan.AdminEmail, ct);
        if (tx is not null) await tx.CommitAsync(ct);

        var link = $"{TenantLinks.Resolve(c.Config, tenant.Slug, tenant.PublicBaseUrl)}/reset-password/{token}";
        var club = await c.Services.GetRequiredService<ClubIdentityResolver>().GetAsync(ct);
        await c.Services.GetRequiredService<IEmailService>().SendAsync(EmailTemplates.ClubReady(club, plan.AdminEmail, link, AdminLinkHours), ct);

        c.Output.WriteLine($"Created club '{tenant.Slug}' ({tenant.DisplayName}) with {plan.Courts} court(s), its two groups and its opening packages.");
        c.Output.WriteLine($"Members reach it at {TenantLinks.Resolve(c.Config, tenant.Slug, tenant.PublicBaseUrl)} — that host must route to this stack (DNS and the tunnel).");
        c.Output.WriteLine($"Queued the first admin's set-your-password mail to {plan.AdminEmail} (link lasts {AdminLinkHours} hours).");
        if (c.Options.Has("print-link")) c.Output.WriteLine($"Set-password link (a credential — pass it on privately): {link}");
        c.Output.WriteLine("Next: the club's admin signs in and sets the club's PayFast account before members can buy minutes.");
        return Ok;
    }

    /// <summary>The bootstrap's opening document, in the club's own zone.</summary>
    private static string InitialSettings(string timezone)
    {
        var doc = System.Text.Json.Nodes.JsonNode.Parse(ProductionBootstrap.InitialSettingsJson)!.AsObject();
        doc["timezone"] = timezone;
        return doc.ToJsonString();
    }

    /// <summary>The club's first admin: no password, a reset token that sets one. Answers the plain token.</summary>
    private static async Task<string> AddFirstAdminAsync(MainframeDbContext db, Tenant tenant, string email, CancellationToken ct)
    {
        var admin = new User
        {
            TenantId = tenant.Id,
            Email = email,
            PasswordHash = null,
            EmailVerified = false,
            IsAdmin = true,
            Status = "active",
        };
        db.Users.Add(admin);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = admin.Id,
            FullName = tenant.DisplayName + " Admin",
            MembershipNumber = await ProductionBootstrap.FreeAdminNumberAsync(db, tenant.Id),
            Status = MembershipStatus.Active,
        });
        var token = TokenHashing.Generate();
        db.AuthTokens.Add(new AuthToken
        {
            TenantId = tenant.Id,
            UserId = admin.Id,
            Kind = TokenKind.PasswordReset,
            TokenHash = TokenHashing.Hash(token),
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(AdminLinkHours),
        });
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.Id,
            ActorUserId = Guid.Empty,
            SubjectUserId = admin.Id,
            Action = "tenant.created_by_operator",
        });
        await db.SaveChangesAsync(ct);
        return token;
    }

    private static async Task<int> SetStatusAsync(CliContext c, string status, CancellationToken ct)
    {
        if (await FindAsync(c, ct) is not { } tenant) return Failed;
        if (tenant.Status == status)
        {
            c.Output.WriteLine($"Club '{tenant.Slug}' is already {status}; nothing changed.");
            return Ok;
        }

        var before = tenant.Status;
        tenant.Status = status;
        c.Db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.Id,
            Action = $"tenant.{status}_by_operator",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { from = before, to = status }),
        });
        await c.Db.SaveChangesAsync(ct);
        c.Output.WriteLine($"Club '{tenant.Slug}' is now {status} (was {before}). A running API takes it up within "
            + $"{(int)TenantResolutionMiddleware.SlugCacheFor.TotalMinutes} minutes; restart the backend for it to apply at once.");
        return Ok;
    }

    private static async Task<int> SetUrlAsync(CliContext c, CancellationToken ct)
    {
        if (await FindAsync(c, ct) is not { } tenant) return Failed;
        string? url = null;
        if (!c.Options.Has("clear"))
        {
            if (c.Options.Get("public-base-url") is not { } candidate) return Fail(c.Output, UsageText, Usage);
            if (TenantLinks.Problem(c.Config, tenant.Slug, candidate) is { } problem)
            {
                return Fail(c.Output, $"set-url refused: the address {problem}.", Failed);
            }

            url = candidate.Trim().TrimEnd('/');
        }

        tenant.PublicBaseUrl = url;
        await c.Db.SaveChangesAsync(ct);
        c.Output.WriteLine($"Club '{tenant.Slug}' links now go to {TenantLinks.Resolve(c.Config, tenant.Slug, tenant.PublicBaseUrl)}.");
        return Ok;
    }

    private static async Task<Tenant?> FindAsync(CliContext c, CancellationToken ct)
    {
        var slug = c.Options.Get("slug")?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(slug))
        {
            c.Output.WriteLine(UsageText);
            return null;
        }

        var tenant = await c.Db.Tenants.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Slug == slug && t.DemoOfTenantId == null, ct);
        if (tenant is null) c.Output.WriteLine($"No club with the slug '{slug}'. `tenant list` names them.");
        return tenant;
    }

    private static int Fail(TextWriter output, string message, int code)
    {
        output.WriteLine(message);
        return code;
    }

    /// <summary><c>--name value</c> pairs and bare <c>--flag</c>s. Null when an argument is not an option.</summary>
    private sealed class Options
    {
        private readonly Dictionary<string, string?> _values = new(StringComparer.Ordinal);

        public static Options? Parse(string[] args)
        {
            var options = new Options();
            for (var i = 0; i < args.Length; i++)
            {
                if (!args[i].StartsWith("--", StringComparison.Ordinal) || args[i].Length < 3) return null;
                var name = args[i][2..];
                var hasValue = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal);
                options._values[name] = hasValue ? args[++i] : null;
            }

            return options;
        }

        public bool Has(string name) => _values.ContainsKey(name);

        public string? Get(string name) => _values.TryGetValue(name, out var v) ? v : null;
    }

    /// <summary>What <c>create</c> was asked for, and every reason it cannot be done.</summary>
    private sealed record CreatePlan(
        string Slug, string Name, string AdminEmail, int Courts, string Timezone, string? PublicBaseUrl, List<string> Problems)
    {
        public static CreatePlan? From(Options o, IConfiguration config)
        {
            var slug = o.Get("slug")?.Trim().ToLowerInvariant();
            var name = o.Get("name")?.Trim();
            var email = o.Get("admin-email")?.Trim().ToLowerInvariant();
            if (slug is null || name is null || email is null) return null;

            var problems = new List<string>();
            CheckSlug(slug, problems);
            CheckNameAndEmail(name, email, problems);
            var courts = CheckCourts(o.Get("courts"), problems);
            var timezone = o.Get("timezone")?.Trim() ?? "Africa/Johannesburg";
            if (!TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out _)) problems.Add($"--timezone '{timezone}' is not an IANA time zone.");
            var url = o.Get("public-base-url")?.Trim().TrimEnd('/');
            if (url is not null && TenantLinks.Problem(config, slug, url) is { } urlProblem) problems.Add($"--public-base-url {urlProblem}.");
            return new CreatePlan(slug, name, email, courts, timezone, url, problems);
        }

        private static void CheckNameAndEmail(string name, string email, List<string> problems)
        {
            if (name.Length is 0 or > 255) problems.Add("--name must be 1 to 255 characters.");
            if (email.Length > 320 || email.IndexOf('@') <= 0 || email.EndsWith('@')) problems.Add($"--admin-email '{email}' is not an email address.");
        }

        /// <summary>The court count, 4 when not given (the bootstrap's default), or a problem.</summary>
        private static int CheckCourts(string? text, List<string> problems)
        {
            if (text is null) return 4;
            if (int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var courts) && courts is >= 1 and <= 64) return courts;
            problems.Add("--courts must be a whole number from 1 to 64.");
            return 4;
        }

        private static void CheckSlug(string slug, List<string> problems)
        {
            if (slug.Length is < 2 or > 64 || !slug.All(ch => char.IsAsciiLetterLower(ch) || char.IsAsciiDigit(ch) || ch == '-')
                || slug.StartsWith('-') || slug.EndsWith('-'))
            {
                problems.Add("--slug must be 2 to 64 lowercase letters, digits and inner hyphens: it is the first label of the club's host name.");
            }
            else if (TenantResolutionMiddleware.ExtractHostSubdomain(slug + ".example.net") is null)
            {
                problems.Add($"--slug '{slug}' is reserved: a host starting '{slug}.' never resolves to a club.");
            }
        }
    }
}
