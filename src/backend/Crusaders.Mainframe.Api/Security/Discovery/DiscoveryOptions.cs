using System.Globalization;
using System.Net;

namespace Crusaders.Mainframe.Api.Security.Discovery;

/// <summary>
/// Deployment knobs for the UDP discovery listener.
///
/// <para>
/// <b>These live in appsettings, not in <c>tenant_settings</c>, and that is a deliberate
/// reading of the "every configurable number is <c>tenant_settings.&lt;key&gt;</c>" rule.</b>
/// The rule governs <i>club policy</i> — slice length, prices, grace windows — numbers an
/// admin changes because the club decided something. Every value here is
/// <i>deployment infrastructure</i>, on the same footing as <c>RateLimits:*</c>, which
/// already lives in appsettings for the same stated reason:
/// </para>
/// <list type="bullet">
///   <item>The listener is a process-wide singleton that binds <b>before any request
///   exists</b>, so there is no tenant to read a setting from. A tenant-scoped port could
///   not be honoured even in principle.</item>
///   <item>The boards it hears from are <b>unclaimed</b> — they belong to no tenant yet.
///   That is the entire point of discovery.</item>
///   <item>The rate limits bound an unauthenticated UDP socket. Letting a tenant admin
///   raise them would move a denial-of-service control inside the blast radius it exists
///   to contain.</item>
/// </list>
/// </summary>
public sealed class DiscoveryOptions
{
    /// <summary>Off switch. A cloud deployment with no club LAN should not hold a socket open for nothing.</summary>
    public bool Enabled { get; init; } = true;

    /// <summary>Fixed at 48653 by the wire protocol. Overridable only so tests can bind an ephemeral port.</summary>
    public int Port { get; init; } = DiscoveryBeacon.Port;

    public IPAddress BindAddress { get; init; } = IPAddress.Any;

    /// <summary>
    /// Hard ceiling on remembered announcers. A club has a handful of courts; anything
    /// past this is a flood, and an unbounded dictionary fed by an unauthenticated UDP
    /// socket is a memory-exhaustion primitive.
    /// </summary>
    public int MaxAnnouncers { get; init; } = 64;

    /// <summary>
    /// How long an announcer stays listed after its last packet. An unclaimed board
    /// announces every 5s, so five minutes is sixty missed beacons — long enough that a
    /// board never flickers out of the admin's list mid-claim, short enough that a
    /// laptop that announced once does not linger all afternoon.
    /// </summary>
    public int AnnouncerTtlSeconds { get; init; } = 300;

    /// <summary>Per-source packet ceiling. An unclaimed board sends 12/minute; this is an order of magnitude of headroom.</summary>
    public int MaxPacketsPerSourcePerMinute { get; init; } = 120;

    /// <summary>
    /// Ceiling on the number of source addresses tracked for rate limiting. UDP source
    /// addresses are trivially spoofed, so the rate-limit table is itself an unbounded
    /// allocation unless it is capped.
    /// </summary>
    public int MaxRateLimitedSources { get; init; } = 256;

    /// <summary>A beacon is a couple of hundred bytes. Anything larger is not one.</summary>
    public int MaxPacketBytes { get; init; } = 512;

    /// <summary>
    /// Base URL handed to a board in the OFFER. Left unset, it is derived per packet from
    /// the local address of the interface that received the beacon plus
    /// <see cref="AdvertisedPort"/> — because <c>App:PublicBaseUrl</c> is a public hostname
    /// or <c>localhost</c>, and a board on the club LAN can reach neither.
    /// </summary>
    public string? AdvertisedBaseUrl { get; init; }

    /// <summary>
    /// True when <see cref="AdvertisedBaseUrl"/> was configured with an <c>https</c> scheme
    /// and rewritten to <c>http</c> because <c>Discovery:DowngradeHttpsAdvertisedBaseUrl</c>
    /// was set. The court box speaks plain HTTP only — a WiFiClient with no TLS context —
    /// so an https URL is one it can never open, for provisioning or for OTA. Without the
    /// flag, <see cref="FromConfiguration"/> refuses to start.
    /// </summary>
    public bool AdvertisedBaseUrlDowngradedFromHttps { get; init; }

    /// <summary>Port a board should call back on. The gateway's, not the backend container's.</summary>
    public int AdvertisedPort { get; init; } = 8088;

    /// <summary>
    /// Last resort when neither an explicit URL nor a local address is available:
    /// <c>App:PublicBaseUrl</c>. Usually wrong for a board — it is the public hostname or
    /// <c>localhost</c> — but a wrong URL a technician can read off the status endpoint
    /// beats an empty field that says nothing.
    /// </summary>
    public string? FallbackBaseUrl { get; init; }

    public static DiscoveryOptions FromConfiguration(IConfiguration config)
    {
        var section = config.GetSection("Discovery");
        var defaults = new DiscoveryOptions();
        var (advertised, downgraded) = AdvertisedBaseUrlFor(section);

        return new DiscoveryOptions
        {
            Enabled = section.GetValue("Enabled", defaults.Enabled),
            Port = section.GetValue("Port", defaults.Port),
            BindAddress = ParseAddress(section["BindAddress"]),
            MaxAnnouncers = section.GetValue("MaxAnnouncers", defaults.MaxAnnouncers),
            AnnouncerTtlSeconds = section.GetValue("AnnouncerTtlSeconds", defaults.AnnouncerTtlSeconds),
            MaxPacketsPerSourcePerMinute =
                section.GetValue("MaxPacketsPerSourcePerMinute", defaults.MaxPacketsPerSourcePerMinute),
            MaxRateLimitedSources = section.GetValue("MaxRateLimitedSources", defaults.MaxRateLimitedSources),
            MaxPacketBytes = section.GetValue("MaxPacketBytes", defaults.MaxPacketBytes),
            AdvertisedBaseUrl = advertised,
            AdvertisedBaseUrlDowngradedFromHttps = downgraded,
            AdvertisedPort = section.GetValue("AdvertisedPort", defaults.AdvertisedPort),
            FallbackBaseUrl = config["App:PublicBaseUrl"],
        };
    }

    /// <summary>
    /// The advertised base URL as the box will be handed it. An <c>https</c> value is a
    /// startup error — the box cannot do TLS, and the closing re-review found the backend
    /// suite pinning such a URL as correct — unless
    /// <c>Discovery:DowngradeHttpsAdvertisedBaseUrl</c> is true, in which case the scheme
    /// is rewritten to <c>http</c> and the fact is reported for Program.cs to log.
    /// </summary>
    private static (string? Url, bool Downgraded) AdvertisedBaseUrlFor(IConfigurationSection section)
    {
        var configured = section["AdvertisedBaseUrl"];
        if (string.IsNullOrWhiteSpace(configured)) return (configured, false);

        var trimmed = configured.Trim();
        if (!trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return (trimmed, false);

        if (!section.GetValue("DowngradeHttpsAdvertisedBaseUrl", false))
        {
            throw new InvalidOperationException(
                $"Discovery:AdvertisedBaseUrl is '{trimmed}', but the court box cannot fetch over TLS: every provisioning " +
                "and OTA URL derived from it would be unreachable. Use the http gateway address, or set " +
                "Discovery:DowngradeHttpsAdvertisedBaseUrl=true to have the scheme rewritten to http (logged at startup).");
        }

        return ("http://" + trimmed["https://".Length..], true);
    }

    public TimeSpan AnnouncerTtl => TimeSpan.FromSeconds(Math.Max(1, AnnouncerTtlSeconds));

    /// <summary>Human-readable bind target, for the diagnostic endpoint.</summary>
    public string Describe() =>
        string.Create(CultureInfo.InvariantCulture, $"{BindAddress}:{Port}/udp");

    private static IPAddress ParseAddress(string? value)
        => string.IsNullOrWhiteSpace(value) || !IPAddress.TryParse(value, out var parsed) ? IPAddress.Any : parsed;
}
