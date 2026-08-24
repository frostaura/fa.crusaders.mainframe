using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Crusaders.Mainframe.Api.Security.Discovery;

/// <summary>
/// Listens on UDP 48653 for board beacons and answers each one with a unicast OFFER.
///
/// <para>
/// <b>In the shipped <c>docker-compose.yml</c> this listener hears nothing at all.</b> The
/// backend is on a bridge network, and broadcast frames from the club LAN do not cross a
/// bridge — not intermittently, never. Host networking is required, which is what
/// <c>docker-compose.onprem.yml</c> exists to apply. That is why binding successfully is
/// reported through <see cref="DiscoveryStore"/> rather than merely logged: an admin
/// looking at an empty board list has to be told "the API cannot hear the LAN" instead of
/// concluding the firmware is broken.
/// </para>
///
/// <para>
/// A failure to bind must never take the application down with it. Since .NET 6 an
/// unhandled exception out of <c>ExecuteAsync</c> stops the host by default, so a port
/// already held by another process would turn a degraded convenience feature into a
/// clubhouse with no booking system. Every failure path here ends in a recorded state and
/// a return.
/// </para>
///
/// <para>
/// No mDNS or Zeroconf package. Layer 3 of the layered design is the <i>board's</i>
/// advertisement, for the benefit of a laptop running any Bonjour browser; the server side
/// of discovery needs exactly one UDP socket, and taking a dependency to open one would be
/// a dependency taken for nothing.
/// </para>
/// </summary>
public sealed class DiscoveryListener : BackgroundService
{
    private readonly DiscoveryOptions _options;
    private readonly DiscoveryStore _store;
    private readonly IDiscoveryDeviceResolver _resolver;
    private readonly ILogger<DiscoveryListener> _logger;

    public DiscoveryListener(
        DiscoveryOptions options,
        DiscoveryStore store,
        IDiscoveryDeviceResolver resolver,
        ILogger<DiscoveryListener> logger)
    {
        _options = options;
        _store = store;
        _resolver = resolver;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            _store.RecordDisabled();
            _logger.LogInformation("Device discovery is disabled by configuration.");
            return;
        }

        using var socket = TryBind();
        if (socket is null) return;

        var buffer = new byte[_options.MaxPacketBytes];
        var any = new IPEndPoint(IPAddress.Any, 0);

        while (!stoppingToken.IsCancellationRequested)
        {
            SocketReceiveFromResult received;

            try
            {
                received = await socket.ReceiveFromAsync(buffer, SocketFlags.None, any, stoppingToken);
            }
            catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException)
            {
                break;
            }
            catch (SocketException ex)
            {
                // An oversized datagram surfaces here on some platforms. The short delay is
                // what stops a hard error that recurs immediately from becoming a spin.
                _store.RecordRejected();
                _logger.LogDebug(ex, "Discovery receive failed.");
                await Task.Delay(TimeSpan.FromMilliseconds(50), stoppingToken);
                continue;
            }

            await SafeHandleAsync(socket, buffer.AsMemory(0, received.ReceivedBytes), received.RemoteEndPoint, stoppingToken);
        }
    }

    private async Task SafeHandleAsync(Socket socket, ReadOnlyMemory<byte> datagram, EndPoint remote, CancellationToken ct)
    {
        try
        {
            if (remote is IPEndPoint ip) await HandlePacketAsync(socket, datagram, ip, ct);
        }
        catch (Exception ex)
        {
            // One malformed or hostile datagram must never end the listen loop.
            _store.RecordRejected();
            _logger.LogDebug(ex, "Discovery packet handling failed.");
        }
    }

    private Socket? TryBind()
    {
        try
        {
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)
            {
                EnableBroadcast = true,
            };

            // ReuseAddress so a restart does not have to wait out the previous socket, and so
            // the listener can coexist with anything else already holding the port on a
            // host-networked box.
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            socket.Bind(new IPEndPoint(_options.BindAddress, _options.Port));

            _store.RecordListening(socket.LocalEndPoint!);
            _logger.LogInformation("Device discovery listening on {Endpoint}.", socket.LocalEndPoint);
            return socket;
        }
        catch (Exception ex)
        {
            // Deliberately unfiltered. The requirement is not "handle the errors we thought
            // of" — it is that nothing on this path can reach the host and stop the club's
            // booking system over a discovery convenience.
            _store.RecordBindFailure($"{ex.GetType().Name}: {ex.Message}");
            _logger.LogError(
                ex,
                "Device discovery could not bind {Target}. Board discovery is unavailable and the API will not hear " +
                "the club LAN. Check that the backend is on host networking — see docker-compose.onprem.yml.",
                _options.Describe());

            return null;
        }
    }

    private async Task HandlePacketAsync(Socket socket, ReadOnlyMemory<byte> datagram, IPEndPoint remote, CancellationToken ct)
    {
        // Rate limiting first: it is the cheapest check, and it is the one that has to hold
        // when everything after it is being fed deliberately.
        if (!_store.TryAdmit(remote.Address)) return;

        var decoded = DiscoveryBeacon.Decode(Encoding.UTF8.GetString(datagram.Span));
        if (!decoded.Ok)
        {
            _store.RecordRejected();
            _logger.LogTrace("Discovery packet from {Remote} rejected: {Error}.", remote.Address, decoded.Error);
            return;
        }

        var frame = decoded.Frame!;

        // An OFFER on the wire is another API answering, or an impostor trying to redirect a
        // board. Either way it is not ours to act on. A beacon without a MAC or a nonce has
        // no identity and cannot be claimed, so there is nothing to remember about it.
        if (!string.Equals(frame.Verb, DiscoveryBeacon.Announce, StringComparison.Ordinal)
            || frame.Get("mac") is not { Length: > 0 } mac
            || frame.Get("n") is not { Length: > 0 } nonce)
        {
            _store.RecordRejected();
            return;
        }

        var owner = await IdentifyAsync(frame, ct);

        _store.Upsert(Describe(frame, remote, mac, nonce, owner));
        _store.RecordAccepted();

        await SendOfferAsync(socket, remote, nonce, owner.Verified == true ? owner.Identity : null, ct);
    }

    /// <summary>
    /// Resolves and verifies a claimed announce. An unclaimed board short-circuits without
    /// touching the database — that is the overwhelming majority of discovery traffic, and
    /// it arrives on an unauthenticated socket.
    /// </summary>
    private async Task<AnnounceOwner> IdentifyAsync(BeaconFrame frame, CancellationToken ct)
    {
        if (!string.Equals(frame.Get("st"), "claimed", StringComparison.Ordinal))
        {
            return new AnnounceOwner(false, null, null);
        }

        if (!Guid.TryParse(frame.Get("dev"), out var deviceId)) return new AnnounceOwner(true, false, null);

        try
        {
            var identity = await _resolver.ResolveAsync(deviceId, ct);
            if (identity is null) return new AnnounceOwner(true, false, null);

            return new AnnounceOwner(true, DiscoveryBeacon.VerifySignature(identity.Key, frame), identity);
        }
        catch (Exception ex)
        {
            // A database that is down degrades discovery to "unverified"; it does not stop
            // the listener. The admin still sees the board, told that it did not verify.
            _logger.LogWarning(ex, "Could not resolve device {DeviceId} for a claimed announce.", deviceId);
            return new AnnounceOwner(true, false, null);
        }
    }

    private static DiscoveredBoard Describe(
        BeaconFrame frame, IPEndPoint remote, string mac, string nonce, AnnounceOwner owner)
    {
        return new DiscoveredBoard
        {
            Mac = mac,
            Address = remote.Address.ToString(),
            Nonce = nonce,
            Hardware = frame.Get("hw"),
            Firmware = frame.Get("fw"),
            MegaVersion = frame.Get("mega"),
            Commitment = frame.Get("cch"),
            Claimed = owner.Claimed,
            DeviceId = Guid.TryParse(frame.Get("dev"), out var id) ? id : null,
            TenantSlug = frame.Get("ten"),
            UptimeSeconds = long.TryParse(frame.Get("up"), CultureInfo.InvariantCulture, out var up) ? up : 0,
            SignatureVerified = owner.Verified,

            // Only a verified signature establishes ownership. A board that merely asserts
            // dev= and ten= is listed, but it belongs to nobody until it proves it —
            // otherwise a forged announce would insert itself into another tenant's list.
            OwnerTenantId = owner.Verified == true ? owner.Identity?.TenantId : null,

            // Overwritten by the store, which owns the clock for both stamps so that
            // first-seen survives an update and last-seen is measured in one place.
            FirstSeenAt = DateTimeOffset.MinValue,
            LastSeenAt = DateTimeOffset.MinValue,
        };
    }

    /// <summary>
    /// Answers the announcer directly. One exchange settles both directions: we learn where
    /// the board is, and the board learns where we are.
    ///
    /// <para>
    /// The OFFER is signed <b>only</b> when the board's own ANNOUNCE verified. Signing on the
    /// strength of an unverified <c>dev=</c> was the obvious alternative and is an HMAC
    /// oracle: device ids are not secret, so anyone could have us sign a canonical string
    /// containing a nonce of their choosing under a real board's key. A claimed board that
    /// cannot verify gets an unsigned OFFER, which it is required to refuse — correct, and it
    /// is exactly the rotated-key case the admin then sees in the board list.
    /// </para>
    /// </summary>
    private async Task SendOfferAsync(
        Socket socket, IPEndPoint remote, string nonce, DiscoveryDeviceIdentity? identity, CancellationToken ct)
    {
        var fields = new List<KeyValuePair<string, string>>
        {
            new("v", DiscoveryBeacon.ProtocolVersion),
            new("url", BaseUrlFor(remote)),
            new("t", DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)),
            new("n", nonce),
        };

        if (identity is not null)
        {
            fields.Add(new KeyValuePair<string, string>(
                "sig", DiscoveryBeacon.Sign(identity.Key, DiscoveryBeacon.Offer, fields)));
        }

        var bytes = Encoding.UTF8.GetBytes(DiscoveryBeacon.Encode(DiscoveryBeacon.Offer, fields));

        try
        {
            await socket.SendToAsync(bytes, SocketFlags.None, remote, ct);
        }
        catch (SocketException ex)
        {
            _logger.LogDebug(ex, "Could not send a discovery OFFER to {Remote}.", remote);
        }
    }

    /// <summary>The URL a board should call back on: an explicit setting, else the address of the interface that can reach it.</summary>
    private string BaseUrlFor(IPEndPoint remote)
    {
        if (!string.IsNullOrWhiteSpace(_options.AdvertisedBaseUrl)) return _options.AdvertisedBaseUrl;

        var local = LocalAddressTowards(remote);
        return local is not null
            ? string.Create(CultureInfo.InvariantCulture, $"http://{local}:{_options.AdvertisedPort}")
            : _options.FallbackBaseUrl ?? string.Empty;
    }

    /// <summary>
    /// Which of this host's addresses the board can reach.
    ///
    /// <para>
    /// <c>Connect</c> on a UDP socket sends nothing — it fixes the peer in the kernel, which
    /// selects the outbound interface and therefore the source address. That is how a
    /// multi-homed on-prem box learns which of its addresses to advertise.
    /// <c>Dns.GetHostAddresses</c> was the alternative and returns a list with no way to
    /// choose from it; inside a host-networked container that list includes every docker
    /// bridge, and advertising one of those is how a board ends up unable to call home.
    /// </para>
    /// </summary>
    private static IPAddress? LocalAddressTowards(IPEndPoint remote)
    {
        try
        {
            using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            probe.Connect(remote.Address, DiscoveryBeacon.Port);
            return (probe.LocalEndPoint as IPEndPoint)?.Address;
        }
        catch (SocketException)
        {
            return null;
        }
    }

    /// <summary>What a claimed announce turned out to be. <c>Verified</c> is null when there was nothing to verify.</summary>
    private readonly record struct AnnounceOwner(bool Claimed, bool? Verified, DiscoveryDeviceIdentity? Identity);
}
