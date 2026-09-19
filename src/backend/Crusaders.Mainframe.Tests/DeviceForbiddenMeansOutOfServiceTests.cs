using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <b>On the device surface a <c>403</c> can mean exactly one thing: the club has taken this
/// board out of service.</b>
///
/// <para>
/// D4 made that status authoritative for the firmware — a <c>403</c> on <c>/gate</c> denies
/// the scan with no roster fallback, and a <c>403</c> on the heartbeat commits an EMPTY
/// roster, while every other failure falls back to the cache. The firmware therefore treats
/// one status as the club's decision rather than as a network event, and it cannot tell a
/// second source of that status apart from the first.
/// </para>
///
/// <para>
/// <b>The backend pinned only the forward direction</b>: that a disabled board really is
/// refused <c>403</c>. The converse — that nothing else on this surface can produce one — was
/// a property of the code that nobody had written down, and it is the half the firmware
/// depends on. A new endpoint filter, an authorization policy with a second requirement, a
/// middleware that starts applying to this group: any of those would make a healthy board
/// purge its roster and deny a member at the door, with no test going red and nothing in the
/// logs distinguishing it from an admin having thrown the switch.
/// </para>
///
/// <para>
/// So this enumerates the group three ways — its routes and their metadata, the SOURCE of
/// everything that can serve or wrap it, and the behaviour of every refusal shape a board can
/// provoke — rather than asserting one example.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceForbiddenMeansOutOfServiceTests
{
    private readonly PostgresFixture _pg;

    public DeviceForbiddenMeansOutOfServiceTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Prefix = "/api/v1/device";

    /// <summary>
    /// The whole device surface. Stated as a literal set rather than derived, so ADDING a
    /// route is a decision somebody makes here with this file's reasoning in front of them.
    /// </summary>
    private static readonly string[] Routes =
    [
        $"{Prefix}/heartbeat",
        $"{Prefix}/gate",
        $"{Prefix}/events",
        $"{Prefix}/walkup",
        $"{Prefix}/activate",
    ];

    // ---- 1. The group's own metadata ----------------------------------------

    /// <summary>
    /// Every route on the surface, and every one of them carrying the SAME authorization and
    /// rate-limit metadata.
    ///
    /// <para>
    /// The uniformity is the assertion. A per-endpoint policy is how a second 403 source
    /// arrives without anybody deciding to add one: an extra <see cref="IAuthorizeData"/> with
    /// its own requirement answers <c>403</c> for a caller who authenticated fine, which is
    /// the one sentence this surface may not say by accident. The rate limiter is checked for
    /// the same reason in reverse — it answers 429 or 503 and must keep doing so.
    /// </para>
    /// </summary>
    [SkippableFact]
    public void The_device_group_is_five_routes_under_one_policy()
    {
        Skip.IfNot(_pg.Available, Skipped);

        using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        using var scope = factory.Services.CreateScope();

        var endpoints = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText?.StartsWith(Prefix, StringComparison.Ordinal) == true)
            .ToList();

        Assert.Equal(
            Routes.Order(),
            endpoints.Select(e => e.RoutePattern.RawText!).Order());

        foreach (var endpoint in endpoints)
        {
            // One authorize marker, with no NAMED policy behind it: a named policy is
            // resolved elsewhere and can carry anything, whereas this group builds its own
            // inline and there is nothing to look up and nothing to drift.
            var one = Assert.Single(endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>());
            Assert.Null(one.Policy);

            // And exactly ONE requirement: the role. A second — a claim, an assertion, a
            // custom handler — is how a caller who authenticated fine starts getting 403s,
            // which on this surface is the club's word that a board is out of service.
            var policy = endpoint.Metadata.GetMetadata<AuthorizationPolicy>();
            Assert.NotNull(policy);
            Assert.Equal([DeviceAuthenticationHandler.SchemeName], policy.AuthenticationSchemes);

            var roles = Assert.IsType<RolesAuthorizationRequirement>(Assert.Single(policy.Requirements));
            Assert.Equal([DeviceAuthenticationHandler.DeviceRole], roles.AllowedRoles);

            var limiter = Assert.IsType<EnableRateLimitingAttribute>(
                Assert.Single(endpoint.Metadata.GetOrderedMetadata<EnableRateLimitingAttribute>()));
            Assert.Equal(RateLimitPolicies.Device, limiter.PolicyName);

            // An endpoint filter is the other way a refusal gets in front of a handler.
            Assert.Empty(endpoint.Metadata.GetOrderedMetadata<IEndpointFilter>());
        }
    }

    /// <summary>
    /// The authorization policy above can only answer <c>403</c> for a caller who
    /// authenticated and is NOT in the role — so the handler must issue that role on every
    /// ticket it ever succeeds with, or the policy becomes a second source.
    /// </summary>
    [Fact]
    public void The_device_scheme_issues_the_role_its_policy_requires()
    {
        var source = File.ReadAllText(Path.Combine(
            ApiSourceRoot(), "Security", "DeviceAuth", "DeviceAuthenticationHandler.cs"));

        // One success path, and it carries the role. Written as a source assertion because
        // the alternative is asserting that no FUTURE success path forgets to.
        Assert.Single(Regex.Matches(source, @"AuthenticateResult\.Success"));
        Assert.Contains("new Claim(ClaimTypes.Role, DeviceRole)", source, StringComparison.Ordinal);
    }

    // ---- 2. Everything that can serve or wrap the group ---------------------

    /// <summary>
    /// The source scan: nothing reachable from this surface produces a <c>403</c> except
    /// <c>DeviceIdentity</c>'s two <c>Results.Forbid()</c> calls, which are the two
    /// <c>!IsActive</c> branches.
    ///
    /// <para>
    /// A source assertion rather than a behavioural one because the property is a NEGATIVE
    /// over inputs nobody has thought of yet: "no request can provoke a 403 from anything but
    /// the disabled check" cannot be driven from the outside, and the failure it guards
    /// against is a future edit rather than a current bug. The files are listed explicitly —
    /// a new handler on this group has to be added here, which is the prompt this test exists
    /// to be.
    /// </para>
    ///
    /// <para>
    /// The two middlewares are in the list because they run BEFORE routing and can therefore
    /// answer for this group. <c>PasswordChangeGate</c> exempts <c>/api/v1/device/</c> by
    /// path; <c>TenantResolutionMiddleware</c>'s only <c>403</c> needs a JWT slug AND a host
    /// slug that disagree, and a device request carries a club key rather than a JWT. Both
    /// facts are asserted rather than trusted.
    /// </para>
    /// </summary>
    [Fact]
    public void Nothing_that_serves_the_device_group_can_answer_forbidden_except_the_disabled_check()
    {
        string[] servers =
        [
            Path.Combine("Endpoints", "DeviceEndpoints.cs"),
            Path.Combine("Endpoints", "DeviceEventEndpoints.cs"),
            Path.Combine("Endpoints", "DeviceGateEndpoint.cs"),
            Path.Combine("Endpoints", "DeviceActivateEndpoint.cs"),
            Path.Combine("Security", "DeviceAuth", "DeviceAuthenticationHandler.cs"),
            Path.Combine("Security", "DeviceAuth", "DeviceKeyResolver.cs"),
        ];

        // `Forbid(`, `403`, `Status403Forbidden` — every spelling that reaches the wire.
        var forbidden = new Regex(@"Results\.Forbid\(|Status403Forbidden|statusCode:\s*403|StatusCode\(403\)");

        foreach (var relative in servers)
        {
            var body = StripComments(File.ReadAllText(Path.Combine(ApiSourceRoot(), relative)));
            Assert.False(
                forbidden.IsMatch(body),
                $"{relative} can answer 403. On the device surface that status is the club's " +
                "word that a board is out of service (spec §7); a second source of it makes a " +
                "healthy board purge its roster and deny a member at the door.");
        }

        var identity = StripComments(File.ReadAllText(Path.Combine(ApiSourceRoot(), "Services", "DeviceIdentity.cs")));
        Assert.Equal(2, Regex.Matches(identity, @"Results\.Forbid\(").Count);
        Assert.Equal(2, Regex.Matches(identity, @"IsActive").Count);

        // The two middlewares that run before routing.
        var passwordGate = File.ReadAllText(Path.Combine(ApiSourceRoot(), "Security", "PasswordChangeGate.cs"));
        Assert.Contains("\"/api/v1/device/\"", passwordGate, StringComparison.Ordinal);

        var tenants = StripComments(File.ReadAllText(Path.Combine(
            ApiSourceRoot(), "Multitenancy", "TenantResolutionMiddleware.cs")));
        var forbids = Regex.Matches(tenants, @"Status403Forbidden");
        Assert.Single(forbids);
        Assert.Contains("jwtSlug is not null && hostSlug is not null", tenants, StringComparison.Ordinal);
    }

    // ---- 3. What a board can actually provoke -------------------------------

    /// <summary>
    /// The behavioural half: every refusal shape a board can provoke on every route, against
    /// an ENABLED board, and not one of them is a <c>403</c>.
    ///
    /// <para>
    /// A malformed MAC, an unknown MAC, a body that is not the record's shape, a token that
    /// resolves to nothing, an unsupported method, a court the board does not drive, a
    /// malformed event: all of them are refusals the firmware must treat as answers, and
    /// under D4 a 403 among them would make the board purge its cached roster.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task No_refusal_a_working_board_can_provoke_is_a_forbidden()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var (key, mac) = await ClubWithABoardAsync(factory);
        var client = factory.CreateClient();

        foreach (var (route, body) in ProvokingBodies(mac))
        {
            var response = await client.SendAsync(Signed(key, route, body));
            Assert.True(
                response.StatusCode != HttpStatusCode.Forbidden,
                $"{route} answered 403 for {body.ToJsonString()} — on this surface that is the " +
                "club's word that the board is out of service, and the board will act on it.");
        }
    }

    /// <summary>
    /// And the forward direction, on all five routes at once: a board the club HAS taken out
    /// of service is refused <c>403</c> whatever it asks, including requests that would
    /// otherwise have been refused for some other reason entirely. The disabled check runs
    /// before the handler, so the status carries one meaning.
    ///
    /// <para>
    /// <b>With one documented exception, pinned here rather than hidden by the loop.</b> An
    /// unrecognised <c>kind</c> on the heartbeat is a 400 checked BEFORE the MAC is resolved
    /// (§3), so a disabled board sending one is told its firmware is wrong rather than that it
    /// is out of service. That ordering is deliberate — a board believing in a device kind
    /// this server does not have should hear so whether or not it has a row — and it costs the
    /// firmware nothing, because a 400 is not a status D4 acts on.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_board_out_of_service_is_forbidden_on_every_route_whatever_it_sends()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var (key, mac) = await ClubWithABoardAsync(factory);
        var client = factory.CreateClient();

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
            row.Enabled = false;
            row.OutOfServiceSince = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }

        foreach (var (route, body) in ProvokingBodies(mac))
        {
            // Only the bodies that name this board: a malformed or unknown MAC is a 400 or a
            // 404 on any board, disabled or not.
            if (body["mac"]?.GetValue<string>() != mac) continue;

            var response = await client.SendAsync(Signed(key, route, body));

            if (body["kind"] is not null)
            {
                Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
                continue;
            }

            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        }
    }

    // ---- fixtures ------------------------------------------------------------

    /// <summary>Every refusal shape a board can put on the wire, per route.</summary>
    private static IEnumerable<(string Route, JsonObject Body)> ProvokingBodies(string mac)
    {
        var unknownMac = Guid.NewGuid().ToString("N")[..12];

        foreach (var route in Routes)
        {
            yield return (route, new JsonObject { ["mac"] = "not-a-mac" });
            yield return (route, new JsonObject { ["mac"] = unknownMac });
            yield return (route, new JsonObject { ["mac"] = mac });
        }

        yield return ($"{Prefix}/gate", new JsonObject { ["mac"] = mac, ["method"] = "pin", ["token"] = "1234" });
        yield return ($"{Prefix}/gate", new JsonObject { ["mac"] = mac, ["method"] = "qr", ["token"] = "ZZZZZZZZZZZZ" });
        yield return ($"{Prefix}/gate", new JsonObject { ["mac"] = mac, ["method"] = "qr" });
        yield return ($"{Prefix}/heartbeat", new JsonObject { ["mac"] = mac, ["kind"] = "turnstile" });
        yield return ($"{Prefix}/walkup", new JsonObject { ["mac"] = mac, ["minutes"] = 9999, ["court"] = 77, ["nonce"] = "n" });
        yield return ($"{Prefix}/walkup", new JsonObject { ["mac"] = mac, ["minutes"] = 30, ["court"] = 1 });
        yield return ($"{Prefix}/activate", new JsonObject { ["mac"] = mac, ["court"] = 99, ["method"] = "qr", ["token"] = "ZZZZZZZZZZZZ" });
        yield return ($"{Prefix}/events", new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 1000,
            ["events"] = new JsonArray(new JsonObject
            {
                ["seq"] = 1,
                ["uptime_ms"] = 500,
                ["kind"] = null,
                ["court"] = -1,
                ["duration_ms"] = 0,
            }),
        });
    }

    private static async Task<(string Key, string Mac)> ClubWithABoardAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"forbid-{Guid.NewGuid():N}"[..24];
        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = $"Club {slug}",
            DeviceApiKey = DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.Courts.Add(new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m });

        var mac = Guid.NewGuid().ToString("N")[..12];
        db.Devices.Add(new Device
        {
            TenantId = tenant.Id,
            DeviceCode = $"box-{mac[^6..]}",
            Name = "Front panel",
            MacAddress = mac,
            CourtNumbers = [1],
            LastSeenAt = DateTimeOffset.UtcNow,
        });

        await db.SaveChangesAsync();
        return (tenant.DeviceApiKey!, mac);
    }

    private static HttpRequestMessage Signed(string key, string path, JsonObject body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return req;
    }

    /// <summary>
    /// The file with its comments removed. These files argue at length ABOUT 403s, so a naive
    /// scan finds the prose rather than the code — and a test that can only pass because
    /// somebody rewrote a comment is worse than no test.
    /// </summary>
    private static string StripComments(string source) =>
        Regex.Replace(Regex.Replace(source, @"/\*.*?\*/", string.Empty, RegexOptions.Singleline),
            @"^\s*(///|//).*$", string.Empty, RegexOptions.Multiline);

    private static string ApiSourceRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "backend", "Crusaders.Mainframe.Api");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Crusaders.Mainframe.Api's sources were not found above the test binary. This test " +
            "reads them on purpose: the property it pins is a negative over future edits, which " +
            "no request can drive from the outside. A missing source tree must fail, not skip.");
    }
}
