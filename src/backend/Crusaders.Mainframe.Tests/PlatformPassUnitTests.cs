using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Biometric;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The backend-platform pass's pure rules (2026-11-13): club addresses (BP-03), the photo byte
/// sniff (BP-04), the passkey ceremony store (BP-10), the biometric driver choice (BP-09), the
/// build a health reply names (IO-05) and the configuration and gateway files the deployment
/// ships (IO-07, BP-13, BP-18). No database; the HTTP behaviour is
/// <see cref="PlatformPassHttpTests"/>.
/// </summary>
public sealed class PlatformPassUnitTests
{
    private static IConfiguration Config(string publicBase, string defaultSlug = "crusaders") =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["App:PublicBaseUrl"] = publicBase,
            ["Tenancy:DefaultTenantSlug"] = defaultSlug,
        }).Build();

    // ---------------------------------------------------------------- club addresses (BP-03)

    /// <summary>
    /// The address rule is the resolution rule run backwards: the club's slug in the first label of
    /// the deployment's host. Varied over the deployment's own address, because the bug was that
    /// every club got THAT address whatever its slug.
    /// </summary>
    [Theory]
    [InlineData("https://crusaders.frostaura.net", "crusaders", "https://crusaders.frostaura.net")]
    [InlineData("https://crusaders.frostaura.net", "kestrel", "https://kestrel.frostaura.net")]
    [InlineData("https://crusaders.frostaura.net/", "kestrel", "https://kestrel.frostaura.net")]
    [InlineData("http://localhost:8088", "crusaders", "http://localhost:8088")]
    [InlineData("http://localhost:8088", "kestrel", "http://kestrel.localhost:8088")]
    [InlineData("http://192.168.68.10:8088", "kestrel", "http://192.168.68.10:8088")]
    [InlineData("https://bookings.club.example:8443", "kestrel", "https://kestrel.club.example:8443")]
    public void A_clubs_address_puts_its_slug_in_the_first_label(string deployment, string slug, string expected)
    {
        Assert.Equal(expected, TenantLinks.Resolve(Config(deployment), slug, storedOverride: null));
    }

    [Fact]
    public void A_stored_address_wins_and_is_trimmed()
    {
        Assert.Equal("https://book.kestrel.example", TenantLinks.Resolve(Config("https://crusaders.frostaura.net"), "kestrel", " https://book.kestrel.example/ "));
    }

    /// <summary>
    /// An operator-set address must resolve back to the club, or every link it builds lands on a
    /// club whose tokens it is not.
    /// </summary>
    [Theory]
    [InlineData("https://kestrel.frostaura.net", null)]
    [InlineData("http://kestrel.localhost:8088", null)]
    [InlineData("https://other.frostaura.net", "resolves to the club 'other'")]
    [InlineData("https://kestrel.frostaura.net/app", "root")]
    [InlineData("https://kestrel.frostaura.net/?x=1", "root")]
    [InlineData("ftp://kestrel.frostaura.net", "http")]
    [InlineData("kestrel.frostaura.net", "http")]
    [InlineData("http://localhost:8088", "resolves to the club 'crusaders'")]
    public void An_operator_address_must_resolve_back_to_its_club(string candidate, string? problemContains)
    {
        var problem = TenantLinks.Problem(Config("https://crusaders.frostaura.net"), "kestrel", candidate);
        if (problemContains is null) Assert.Null(problem);
        else Assert.Contains(problemContains, problem, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------- photo bytes (BP-04)

    [Fact]
    public void The_bytes_decide_a_photos_type_never_the_label()
    {
        Assert.Equal("png", MemberPhotoFiles.Sniff(TestPhotos.Png()));
        Assert.Equal("jpg", MemberPhotoFiles.Sniff(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0, 0 }));
        Assert.Equal("gif", MemberPhotoFiles.Sniff("GIF89a......"u8.ToArray()));
        Assert.Equal("webp", MemberPhotoFiles.Sniff("RIFF\0\0\0\0WEBPVP8 "u8.ToArray()));
        Assert.Null(MemberPhotoFiles.Sniff("<svg xmlns='http://www.w3.org/2000/svg'/>"u8.ToArray()));
        Assert.Null(MemberPhotoFiles.Sniff("RIFF\0\0\0\0WAVEfmt "u8.ToArray()));
        Assert.Null(MemberPhotoFiles.Sniff(new byte[] { 0x89, 0x50, 0x4E }));
        Assert.Null(MemberPhotoFiles.Sniff([]));
    }

    /// <summary>Only a URL this product issued to this club is a photo — shape, club and name.</summary>
    [Theory]
    [InlineData("/uploads/kestrel/photos/0123456789abcdef0123456789abcdef.png", true)]
    [InlineData("/uploads/kestrel/photos/0123456789abcdef0123456789abcdef.jpg", true)]
    [InlineData("/uploads/crusaders/photos/0123456789abcdef0123456789abcdef.png", false)]
    [InlineData("/uploads/kestrel/photos/../../crusaders/photos/0123456789abcdef0123456789abcdef.png", false)]
    [InlineData("/uploads/kestrel/photos/0123456789ABCDEF0123456789abcdef.png", false)]
    [InlineData("/uploads/kestrel/photos/0123456789abcdef0123456789abcdef.svg", false)]
    [InlineData("https://evil.example/pixel.png", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("data:image/png;base64,iVBORw0KGgo=", false)]
    [InlineData("", false)]
    public void Only_a_url_issued_to_this_club_is_a_photo(string url, bool issued)
    {
        Assert.Equal(issued, MemberPhotoFiles.IsIssued("kestrel", url));
    }

    // ---------------------------------------------------------------- passkey ceremonies (BP-10)

    /// <summary>
    /// A full store refuses the new ceremony instead of growing, and never evicts one in flight:
    /// the anonymous options route parked an entry per call in an unbounded cache.
    /// </summary>
    [Fact]
    public void A_full_ceremony_store_refuses_the_newcomer_and_keeps_everyone_in_flight()
    {
        using var flows = new WebAuthnFlows(capacity: 3);
        Assert.True(flows.TryStore("a", "1"));
        Assert.True(flows.TryStore("b", "2"));
        Assert.True(flows.TryStore("c", "3"));

        Assert.False(flows.TryStore("d", "4"));

        Assert.Equal("1", flows.Take("a"));
        Assert.Equal("2", flows.Take("b"));
        Assert.Equal("3", flows.Take("c"));
        Assert.Null(flows.Take("a"));            // once only
        Assert.True(flows.TryStore("d", "4"));   // room again once taken
    }

    // ---------------------------------------------------------------- biometric driver (BP-09)

    private sealed class Env(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "tests";
        public string ContentRootPath { get; set; } = ".";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } =
            new Microsoft.Extensions.FileProviders.NullFileProvider();
    }

    /// <summary>
    /// The simulator matches the first enrolled candidate; it was registered in Production too.
    /// It is honoured only where it was asked for in Development or Testing.
    /// </summary>
    [Theory]
    [InlineData("Null", "Development", typeof(NullBiometricDevice))]
    [InlineData("Null", "Testing", typeof(NullBiometricDevice))]
    [InlineData("null", "Development", typeof(NullBiometricDevice))]
    [InlineData("Null", "Production", typeof(NoBiometricDevice))]
    [InlineData("None", "Development", typeof(NoBiometricDevice))]
    [InlineData(null, "Development", typeof(NoBiometricDevice))]
    [InlineData("Suprema", "Production", typeof(NoBiometricDevice))]
    public void The_simulator_runs_only_where_it_was_asked_for_outside_production(string? driver, string environment, Type expected)
    {
        Assert.IsType(expected, BiometricDrivers.For(driver, new Env(environment)));
    }

    [Fact]
    public async Task No_reader_matches_nobody_even_with_candidates()
    {
        var none = new NoBiometricDevice();
        var match = await none.IdentifyAsync(new BiometricCapture([], 100, 1), [new EnrolledTemplateRef("t", Guid.NewGuid())], new IdentifyOptions(), default);
        Assert.False(match.Matched);
        Assert.Null(match.MatchedUserId);
        var enrol = await none.EnrollAsync(new EnrollmentRequest(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), null, "v1"), default);
        Assert.False(enrol.Ok);
        Assert.Equal(NoBiometricDevice.Unavailable, enrol.FailureReason);
    }

    // ---------------------------------------------------------------- build identity (IO-05)

    [Theory]
    [InlineData("1.0.0+3f2c9ab", "1.0.0", "3f2c9ab")]
    [InlineData("1.0.0", "1.0.0", BuildInfo.UnknownRevision)]
    [InlineData("1.0.0+", "1.0.0", BuildInfo.UnknownRevision)]
    [InlineData(null, "0.0.0", BuildInfo.UnknownRevision)]
    public void A_builds_informational_version_splits_into_version_and_revision(string? informational, string version, string revision)
    {
        var build = BuildInfo.From(informational);
        Assert.Equal(version, build.Version);
        Assert.Equal(revision, build.Revision);
    }

    [Fact]
    public async Task Liveness_names_the_build_and_touches_no_database()
    {
        await using var factory = new TestWebAppFactory();   // no database at all
        using var response = await factory.CreateClient().GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("ok", body.GetProperty("status").GetString());
        Assert.Equal(BuildInfo.Current.Version, body.GetProperty("version").GetString());
        Assert.Equal(BuildInfo.Current.Revision, body.GetProperty("revision").GetString());
    }

    /// <summary>
    /// Readiness is NOT liveness: with no reachable database it answers 503 and says which
    /// dependency failed, never how (no connection string, no exception text).
    /// </summary>
    [Fact]
    public async Task Readiness_without_a_database_is_503_and_names_only_the_dependency()
    {
        await using var factory = new TestWebAppFactory
        {
            // A port nothing listens on: refused at once, whatever else runs on this machine.
            ConnectionString = null,
        };
        await using var unreachable = factory.WithWebHostBuilder(b => b.UseSetting(
            "ConnectionStrings:DefaultConnection", "Host=127.0.0.1;Port=1;Database=none;Username=none;Password=none;Timeout=1"));
        using var response = await unreachable.CreateClient().GetAsync("/readyz");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync();
        var body = JsonDocument.Parse(text).RootElement;
        Assert.Equal("not_ready", body.GetProperty("status").GetString());
        Assert.Contains(body.GetProperty("database").GetString(), new[] { "unreachable", "timeout" });
        Assert.Equal(BuildInfo.Current.Revision, body.GetProperty("revision").GetString());
        Assert.DoesNotContain("Host=", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Exception", text, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------- shipped files (IO-07, BP-13, BP-18)

    private static string Repo(params string[] parts)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "docker-compose.prod.yml"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine([dir!.FullName, .. parts]));
    }

    /// <summary>
    /// IO-07: EF logged every SQL command at Information in production (~35 KB a minute idle on
    /// the Pi). The base file is what Production runs on.
    /// </summary>
    [Fact]
    public void Production_logs_ef_and_request_lines_at_warning()
    {
        var levels = JsonDocument.Parse(Repo("src", "backend", "Crusaders.Mainframe.Api", "appsettings.json"))
            .RootElement.GetProperty("Logging").GetProperty("LogLevel");
        Assert.Equal("Warning", levels.GetProperty("Microsoft.EntityFrameworkCore").GetString());
        Assert.Equal("Warning", levels.GetProperty("Microsoft.AspNetCore.Hosting.Diagnostics").GetString());
    }

    /// <summary>IO-07: every production service's json-file log is capped, or the SD card fills.</summary>
    [Fact]
    public void Every_production_service_caps_its_container_log()
    {
        var compose = Repo("docker-compose.prod.yml");
        var services = compose[compose.IndexOf("\nservices:", StringComparison.Ordinal)..compose.IndexOf("\nvolumes:", StringComparison.Ordinal)];
        var names = System.Text.RegularExpressions.Regex.Matches(services, @"(?m)^  ([a-z]+):\s*$").Select(m => m.Groups[1].Value).ToList();
        Assert.Contains("backend", names);
        Assert.Contains("cloudflared", names);
        foreach (var name in names)
        {
            var start = services.IndexOf($"\n  {name}:", StringComparison.Ordinal);
            var next = names.IndexOf(name) + 1 < names.Count ? services.IndexOf($"\n  {names[names.IndexOf(name) + 1]}:", StringComparison.Ordinal) : services.Length;
            Assert.True(services[start..next].Contains("logging: *default-logging", StringComparison.Ordinal), $"service {name} has no capped log");
        }

        Assert.Contains("max-size: \"10m\"", compose, StringComparison.Ordinal);
        Assert.Contains("max-file: \"5\"", compose, StringComparison.Ordinal);
    }

    /// <summary>BP-13: configuration keys nothing reads are gone, and the refresh key is the one read.</summary>
    [Fact]
    public void The_shipped_settings_carry_no_key_nothing_reads()
    {
        var text = Repo("src", "backend", "Crusaders.Mainframe.Api", "appsettings.json");
        Assert.DoesNotContain("FrontendUrl", text, StringComparison.Ordinal);
        Assert.DoesNotContain("ResolveFromOrder", text, StringComparison.Ordinal);
        Assert.DoesNotContain("RefreshTokenExpiryDays", text, StringComparison.Ordinal);
        Assert.DoesNotContain("X-Tenant", text, StringComparison.Ordinal);
        var jwt = JsonDocument.Parse(text).RootElement.GetProperty("Jwt");
        Assert.Equal(30, jwt.GetProperty("RefreshTokenLifetimeDays").GetInt32());
        Assert.Equal("None", JsonDocument.Parse(text).RootElement.GetProperty("Biometric").GetProperty("Driver").GetString());
    }

    /// <summary>
    /// BP-18, BM-22: the gateway's access log is the redacted format, and the redaction covers the
    /// stream ticket and every one-time link path. (CI's real-nginx pass loads this file; the
    /// redaction itself was exercised against nginx 1.27 when written.)
    /// </summary>
    [Fact]
    public void The_gateway_logs_requests_without_their_credentials()
    {
        var conf = Repo("nginx", "nginx.conf");
        Assert.Contains("access_log /var/log/nginx/access.log crusaders_redacted;", conf, StringComparison.Ordinal);
        Assert.Contains("ticket=)[^&]*", conf, StringComparison.Ordinal);
        foreach (var path in new[] { "verify-email", "reset-password", "welcome", "magic-link", "invites" })
        {
            Assert.Contains(path, conf, StringComparison.Ordinal);
        }

        var format = conf[conf.IndexOf("log_format crusaders_redacted", StringComparison.Ordinal)..];
        format = format[..format.IndexOf(';')];
        Assert.DoesNotContain("$request ", format, StringComparison.Ordinal);
        Assert.DoesNotContain("$request_uri", format, StringComparison.Ordinal);
        Assert.DoesNotContain("$http_referer", format, StringComparison.Ordinal);
    }

    /// <summary>BP-06: the document's CSP loads images only from this origin, data: and blob:.</summary>
    [Fact]
    public void The_gateway_loads_images_from_nowhere_else()
    {
        var conf = Repo("nginx", "nginx.conf");
        var csp = Regex.Match(conf, @"(?m)^\s*add_header Content-Security-Policy ""(?<v>[^""]*)"" always;").Groups["v"].Value;
        Assert.Contains("img-src 'self' data: blob:", csp, StringComparison.Ordinal);
        Assert.Contains("frame-ancestors 'none'", csp, StringComparison.Ordinal);
    }

    [Fact]
    public void The_gateway_passes_readiness_through()
    {
        Assert.Contains("location = /readyz", Repo("nginx", "nginx.conf"), StringComparison.Ordinal);
        Assert.Contains("/readyz", Repo("docker-compose.prod.yml"), StringComparison.Ordinal);
    }

    [Fact]
    public void The_backend_image_is_stamped_with_its_commit()
    {
        Assert.Contains("SourceRevisionId=$BUILD_SHA", Repo("src", "backend", "Dockerfile"), StringComparison.Ordinal);
        var ci = Repo(".github", "workflows", "ci.yml");
        // Both backend image builds pass the commit (the release-ops pass moved every image to a
        // multi-line build-args block, beside the revision label).
        foreach (var job in new[] { "build-backend-amd64:", "build-backend-arm64:" })
        {
            var start = ci.IndexOf("  " + job, StringComparison.Ordinal);
            Assert.True(start >= 0, job);
            var next = System.Text.RegularExpressions.Regex.Match(ci[(start + job.Length + 2)..], @"\n  [a-z][a-z0-9-]*:\n");
            var section = next.Success ? ci.Substring(start, job.Length + 2 + next.Index) : ci[start..];
            Assert.Matches(@"BUILD_SHA=\$\{\{ github\.sha \}\}", section);
        }
    }
}
