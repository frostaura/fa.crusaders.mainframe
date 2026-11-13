using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The address a club's members use, for every link the product writes into a mail or hands to
/// PayFast (BP-03).
///
/// <para>
/// <b>Why it is per club.</b> Every verify, reset and welcome link used to be built from the one
/// deployment-wide <c>App:PublicBaseUrl</c>. The token behind each link is looked up inside the
/// club the request arrives at, and the club is read off the request's host
/// (<see cref="TenantResolutionMiddleware.ExtractHostSubdomain"/>) — so a second club's link
/// opened on the first club's host, found no token, and answered <c>invalid_or_expired</c>. Nobody
/// at club #2 could confirm an address, reset a password or take the welcome link: nobody could
/// join.
/// </para>
///
/// <para>
/// <b>The rule is the resolution rule run backwards.</b> A club is reached at the host whose first
/// label is its slug, so its address is the deployment's own with that label replaced:
/// <c>https://crusaders.frostaura.net</c> becomes <c>https://kestrel.frostaura.net</c> for the
/// club whose slug is <c>kestrel</c>. A host with no tenant label (<c>localhost</c>, an IP) is the
/// default club's (<c>Tenancy:DefaultTenantSlug</c>); another club on <c>localhost</c> is
/// <c>kestrel.localhost</c>, which every browser resolves to the loopback. A club whose members use
/// some other address carries it in <see cref="Domain.Tenant.PublicBaseUrl"/>, set by the operator
/// CLI, which refuses one whose host would not resolve back to that club.
/// </para>
///
/// <para>
/// A demo club's links are its real club's: a demo club is only ever entered from the real club's
/// address, by its admin's token.
/// </para>
/// </summary>
public sealed class TenantLinks
{
    private const string FallbackBaseUrl = "http://localhost:8088";

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IConfiguration _config;

    public TenantLinks(MainframeDbContext db, ITenantContext tenant, IConfiguration config)
    {
        _db = db; _tenant = tenant; _config = config;
    }

    /// <summary>The current club's address, no trailing slash.</summary>
    public Task<string> BaseUrlAsync(CancellationToken ct) => ForTenantAsync(_db, _config, _tenant.TenantId, ct);

    /// <summary>A club's address, for a caller that holds the club's id but no request (a worker).</summary>
    public static async Task<string> ForTenantAsync(MainframeDbContext db, IConfiguration config, Guid tenantId, CancellationToken ct)
    {
        var row = await db.Tenants.IgnoreQueryFilters().AsNoTracking()
            .Where(t => t.Id == tenantId)
            .Select(t => new { t.Slug, t.PublicBaseUrl, t.DemoOfTenantId })
            .FirstOrDefaultAsync(ct);
        if (row is null) return DeploymentBaseUrl(config);
        if (row.DemoOfTenantId is { } source && source != tenantId)
        {
            return await ForTenantAsync(db, config, source, ct);
        }

        return Resolve(config, row.Slug, row.PublicBaseUrl);
    }

    /// <summary>The deployment's own address, <c>App:PublicBaseUrl</c>, trimmed.</summary>
    public static string DeploymentBaseUrl(IConfiguration config)
        => Trim(config["App:PublicBaseUrl"] is { Length: > 0 } configured ? configured : FallbackBaseUrl);

    /// <summary>
    /// The pure rule: a stored override wins, else the deployment's address with the club in its
    /// first label. See the type's remarks.
    /// </summary>
    public static string Resolve(IConfiguration config, string slug, string? storedOverride)
    {
        if (!string.IsNullOrWhiteSpace(storedOverride)) return Trim(storedOverride);

        var deployment = DeploymentBaseUrl(config);
        if (!Uri.TryCreate(deployment, UriKind.Absolute, out var uri)) return deployment;

        var hostSlug = TenantResolutionMiddleware.ExtractHostSubdomain(uri.Host);
        if (string.Equals(hostSlug, slug, StringComparison.OrdinalIgnoreCase)) return deployment;

        if (hostSlug is null)
        {
            // localhost, an IP or a single-label host: the default club lives there.
            var defaultSlug = config["Tenancy:DefaultTenantSlug"];
            if (string.Equals(defaultSlug, slug, StringComparison.OrdinalIgnoreCase)) return deployment;
            if (System.Net.IPAddress.TryParse(uri.Host, out _)) return deployment;
            return Rebuild(uri, $"{slug}.{uri.Host}");
        }

        var firstDot = uri.Host.IndexOf('.');
        return Rebuild(uri, slug + uri.Host[firstDot..]);
    }

    /// <summary>
    /// Why an operator-supplied address cannot be a club's, or null when it can: absolute http(s),
    /// no path, query or fragment, and a host that the request-side rule resolves to this club.
    /// </summary>
    public static string? Problem(IConfiguration config, string slug, string candidate)
    {
        if (!Uri.TryCreate(candidate.Trim(), UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https"))
        {
            return "must be an absolute http:// or https:// address";
        }

        if (uri.AbsolutePath is not ("/" or "") || uri.Query.Length > 0 || uri.Fragment.Length > 0)
        {
            return "must be the site's root, with no path, query or fragment";
        }

        var hostSlug = TenantResolutionMiddleware.ExtractHostSubdomain(uri.Host);
        var resolvesTo = hostSlug ?? config["Tenancy:DefaultTenantSlug"];
        return string.Equals(resolvesTo, slug, StringComparison.OrdinalIgnoreCase)
            ? null
            : $"its host resolves to the club '{resolvesTo ?? "(none)"}', not '{slug}': the first label of the host is how a request finds its club";
    }

    private static string Rebuild(Uri uri, string host)
    {
        var builder = new UriBuilder(uri) { Host = host };
        return Trim(builder.Uri.GetLeftPart(UriPartial.Authority));
    }

    private static string Trim(string url) => url.Trim().TrimEnd('/');
}
