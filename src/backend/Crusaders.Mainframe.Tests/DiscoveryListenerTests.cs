using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Crusaders.Mainframe.Api.Security.Discovery;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The listener driven over a real loopback UDP socket.
///
/// <para>
/// Real sockets, not a fake transport. The thing most likely to be wrong about a UDP
/// listener is the socket setup — binding, the receive loop, the unicast reply going back to
/// the announcer's ephemeral source port rather than to 48653 — and none of that is
/// exercised by handing bytes to a method. Everything binds to <b>port 0</b>, so the kernel
/// allocates an ephemeral port and two test runs on one machine can never collide.
/// </para>
///
/// <para>
/// The packets are the corpus's own bytes where a corpus case exists, so a listener that
/// somehow disagreed with the wire format would fail here as well as in the corpus suite.
/// </para>
/// </summary>
public class DiscoveryListenerTests
{
    private const string AdvertisedUrl = "http://192.168.68.20:8088";

    private const string UnclaimedAnnounce =
        "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c hw=esp8266 fw=1.0.0 st=unclaimed n=a1b2c3d4e5f60718 " +
        "cch=a13aa6c2c45e1b1c up=42*77\n";

    private const string ClaimedAnnounce =
        "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c hw=esp8266 fw=1.0.0 mega=0.9.1 st=claimed n=a1b2c3d4e5f60718 " +
        "dev=3fa85f64-5717-4562-b3fc-2c963f66afa6 ten=crusaders up=86400 " +
        "sig=47f850306320a76f69d4f0230a8a3ac4c53baa239059252e517cf3aaf5644c56*4D\n";

    private static readonly Guid ClaimedDeviceId = Guid.Parse("3fa85f64-5717-4562-b3fc-2c963f66afa6");

    private static readonly byte[] CorpusKey =
        Convert.FromHexString("00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f");

    /// <summary>
    /// A resolver with no database behind it. The listener's job is sockets and framing;
    /// whether a device row exists is a different concern, and wiring Postgres into a socket
    /// test would only make it slower and flakier.
    /// </summary>
    private sealed class StubResolver : IDiscoveryDeviceResolver
    {
        public DiscoveryDeviceIdentity? Identity { get; init; }

        public Task<DiscoveryDeviceIdentity?> ResolveAsync(Guid deviceId, CancellationToken ct)
            => Task.FromResult(Identity is not null && Identity.DeviceId == deviceId ? Identity : null);
    }

    private sealed record Harness(DiscoveryListener Listener, DiscoveryStore Store, IPEndPoint Endpoint) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() => await Listener.StopAsync(CancellationToken.None);
    }

    private static async Task<Harness> StartAsync(
        IDiscoveryDeviceResolver? resolver = null, DiscoveryOptions? options = null)
    {
        var opts = options ?? new DiscoveryOptions
        {
            Port = 0,                        // ephemeral: tests must never collide on 48653
            BindAddress = IPAddress.Loopback,
            AdvertisedBaseUrl = AdvertisedUrl,
        };

        var store = new DiscoveryStore(opts);
        var listener = new DiscoveryListener(
            opts, store, resolver ?? new StubResolver(), NullLogger<DiscoveryListener>.Instance);

        await listener.StartAsync(CancellationToken.None);

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (store.Status().BoundEndpoint is null && DateTime.UtcNow < deadline)
        {
            await Task.Delay(10);
        }

        var bound = store.Status().BoundEndpoint;
        Assert.NotNull(bound);

        return new Harness(listener, store, IPEndPoint.Parse(bound));
    }

    private static async Task SendAsync(UdpClient client, IPEndPoint target, string packet)
    {
        var bytes = Encoding.UTF8.GetBytes(packet);
        await client.SendAsync(bytes, bytes.Length, target);
    }

    /// <summary>
    /// Waits for the listener to reach a state.
    ///
    /// <para>
    /// Necessary because <c>BackgroundService.StartAsync</c> on .NET 10 no longer runs
    /// <c>ExecuteAsync</c> inline — it schedules it — so a state assertion taken immediately
    /// after <c>StartAsync</c> races the listener rather than observing it.
    /// </para>
    /// </summary>
    private static async Task WaitForStateAsync(DiscoveryStore store, DiscoveryListenerState expected)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (store.Status().State != expected && DateTime.UtcNow < deadline)
        {
            await Task.Delay(10);
        }
    }

    private static async Task WaitForReceivedAsync(DiscoveryStore store, long count)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (store.Status().PacketsReceived < count && DateTime.UtcNow < deadline)
        {
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task An_unclaimed_announce_is_recorded_and_answered_with_an_unsigned_offer()
    {
        await using var h = await StartAsync();
        using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));

        await SendAsync(client, h.Endpoint, UnclaimedAnnounce);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var reply = await client.ReceiveAsync(cts.Token);
        var offer = DiscoveryBeacon.Decode(Encoding.UTF8.GetString(reply.Buffer));

        Assert.True(offer.Ok, $"The OFFER did not decode: {offer.Error}");
        Assert.Equal(DiscoveryBeacon.Offer, offer.Frame!.Verb);
        Assert.Equal(AdvertisedUrl, offer.Frame.Get("url"));
        Assert.Equal(DiscoveryBeacon.ProtocolVersion, offer.Frame.Get("v"));

        // The nonce is echoed so an OFFER cannot be replayed at a later boot.
        Assert.Equal("a1b2c3d4e5f60718", offer.Frame.Get("n"));

        // Nothing to sign with: an unclaimed board has no key.
        Assert.Null(offer.Frame.Get("sig"));

        // The board has no RTC and re-syncs from this.
        var t = long.Parse(offer.Frame.Get("t")!, CultureInfo.InvariantCulture);
        Assert.InRange(t, DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 60, DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60);

        var board = Assert.Single(h.Store.Snapshot());
        Assert.Equal("5ccf7f1a2b3c", board.Mac);
        Assert.Equal("esp8266", board.Hardware);
        Assert.Equal("1.0.0", board.Firmware);
        Assert.Equal("a13aa6c2c45e1b1c", board.Commitment);
        Assert.Equal(42, board.UptimeSeconds);
        Assert.False(board.Claimed);
        Assert.Null(board.SignatureVerified);      // nothing was signed, so nothing was verified
        Assert.Null(board.OwnerTenantId);
        Assert.Equal(IPAddress.Loopback.ToString(), board.Address);

        var status = h.Store.Status();
        Assert.Equal(DiscoveryListenerState.Listening, status.State);
        Assert.Equal(1, status.PacketsAccepted);
        Assert.NotNull(status.LastPacketAt);
    }

    /// <summary>
    /// A claimed board that proves its identity is marked verified, its tenant is recorded,
    /// and its OFFER is signed — which is the only kind a claimed box will accept.
    /// </summary>
    [Fact]
    public async Task A_claimed_announce_that_verifies_gets_a_signed_offer()
    {
        var tenantId = Guid.NewGuid();
        var resolver = new StubResolver
        {
            Identity = new DiscoveryDeviceIdentity(ClaimedDeviceId, tenantId, "crusaders", CorpusKey),
        };

        await using var h = await StartAsync(resolver);
        using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));

        await SendAsync(client, h.Endpoint, ClaimedAnnounce);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var reply = await client.ReceiveAsync(cts.Token);
        var offer = DiscoveryBeacon.Decode(Encoding.UTF8.GetString(reply.Buffer));

        Assert.True(offer.Ok);
        Assert.NotNull(offer.Frame!.Get("sig"));
        Assert.True(DiscoveryBeacon.VerifySignature(CorpusKey, offer.Frame));

        var board = Assert.Single(h.Store.Snapshot());
        Assert.True(board.Claimed);
        Assert.True(board.SignatureVerified);
        Assert.Equal(tenantId, board.OwnerTenantId);
        Assert.Equal(ClaimedDeviceId, board.DeviceId);
        Assert.Equal("0.9.1", board.MegaVersion);
    }

    /// <summary>
    /// A board whose key has been rotated out from under it is <b>listed and marked</b>, not
    /// dropped. An admin cannot fix what they cannot see, and this is also what a spoof looks
    /// like — so it must reach the screen either way.
    ///
    /// <para>
    /// Its OFFER is unsigned, which a claimed box will refuse. Signing on the strength of an
    /// unverified <c>dev=</c> would be an HMAC oracle: device ids are not secret.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_claimed_announce_that_does_not_verify_is_listed_as_unverified_and_gets_no_signature()
    {
        var otherKey = new byte[32];
        Array.Fill(otherKey, (byte)0x5A);

        var resolver = new StubResolver
        {
            Identity = new DiscoveryDeviceIdentity(ClaimedDeviceId, Guid.NewGuid(), "someone-else", otherKey),
        };

        await using var h = await StartAsync(resolver);
        using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));

        await SendAsync(client, h.Endpoint, ClaimedAnnounce);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var reply = await client.ReceiveAsync(cts.Token);
        var offer = DiscoveryBeacon.Decode(Encoding.UTF8.GetString(reply.Buffer));

        Assert.True(offer.Ok);
        Assert.Null(offer.Frame!.Get("sig"));

        var board = Assert.Single(h.Store.Snapshot());
        Assert.True(board.Claimed);
        Assert.False(board.SignatureVerified);

        // Unproven, so it belongs to nobody — a forged announce must not insert itself into
        // another tenant's board list.
        Assert.Null(board.OwnerTenantId);
    }

    [Fact]
    public async Task Malformed_traffic_is_counted_and_never_stored()
    {
        await using var h = await StartAsync();
        using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));

        // A printer, a corrupted beacon, a beacon for a verb we do not speak, and a beacon
        // with no identity at all. Port 48653 sees all of these on a club LAN.
        await SendAsync(client, h.Endpoint, "M-SEARCH * HTTP/1.1\r\n");
        await SendAsync(client, h.Endpoint, "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c*00\n");
        await SendAsync(client, h.Endpoint, "CRSDR1 SHOUT v=1*7A\n");
        await SendAsync(client, h.Endpoint, "CRSDR1 OFFER v=1 url=http://evil t=1 n=abc*73\n");

        await WaitForReceivedAsync(h.Store, 4);

        Assert.Empty(h.Store.Snapshot());
        Assert.Equal(0, h.Store.Status().PacketsAccepted);
        Assert.True(h.Store.Status().PacketsRejected >= 4);
    }

    /// <summary>
    /// The store is bounded and the socket is unauthenticated, so the rate limit has to hold
    /// under a flood from one source rather than merely exist.
    /// </summary>
    [Fact]
    public async Task A_flood_from_one_source_is_capped()
    {
        var options = new DiscoveryOptions
        {
            Port = 0,
            BindAddress = IPAddress.Loopback,
            AdvertisedBaseUrl = AdvertisedUrl,
            MaxPacketsPerSourcePerMinute = 3,
        };

        await using var h = await StartAsync(options: options);
        using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));

        for (var i = 0; i < 12; i++) await SendAsync(client, h.Endpoint, UnclaimedAnnounce);

        await WaitForReceivedAsync(h.Store, 12);

        var status = h.Store.Status();
        Assert.Equal(12, status.PacketsReceived);
        Assert.Equal(3, status.PacketsAccepted);
        Assert.Equal(9, status.PacketsRejected);
    }

    /// <summary>
    /// A board that changes address updates in place. Keying on the MAC rather than the
    /// address is what stops one box on DHCP from filling the list with its own history.
    /// </summary>
    [Fact]
    public async Task One_board_announcing_twice_stays_one_entry()
    {
        await using var h = await StartAsync();
        using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));

        await SendAsync(client, h.Endpoint, UnclaimedAnnounce);
        await SendAsync(client, h.Endpoint, UnclaimedAnnounce);
        await WaitForReceivedAsync(h.Store, 2);

        Assert.Single(h.Store.Snapshot());
        Assert.Equal(2, h.Store.Status().PacketsAccepted);
    }

    /// <summary>
    /// The requirement that outranks discovery working at all: a listener that cannot bind
    /// must degrade, not take the host with it.
    ///
    /// <para>
    /// Since .NET 6 an exception escaping <c>ExecuteAsync</c> stops the host by default. A
    /// port already held, or a container without permission to hold one, would then turn a
    /// convenience feature into a clubhouse with no booking system. The address here is
    /// TEST-NET-3, which is guaranteed not to be assigned to any local interface.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_listener_that_cannot_bind_records_why_and_does_not_throw()
    {
        var options = new DiscoveryOptions
        {
            Port = 0,
            BindAddress = IPAddress.Parse("203.0.113.9"),
        };

        var store = new DiscoveryStore(options);
        var listener = new DiscoveryListener(
            options, store, new StubResolver(), NullLogger<DiscoveryListener>.Instance);

        await listener.StartAsync(CancellationToken.None);
        await WaitForStateAsync(store, DiscoveryListenerState.Failed);
        await listener.StopAsync(CancellationToken.None);

        var status = store.Status();
        Assert.Equal(DiscoveryListenerState.Failed, status.State);
        Assert.NotNull(status.Detail);
        Assert.Null(status.BoundEndpoint);
    }

    [Fact]
    public async Task A_disabled_listener_says_so_rather_than_looking_broken()
    {
        var options = new DiscoveryOptions { Enabled = false };
        var store = new DiscoveryStore(options);
        var listener = new DiscoveryListener(
            options, store, new StubResolver(), NullLogger<DiscoveryListener>.Instance);

        await listener.StartAsync(CancellationToken.None);
        await WaitForStateAsync(store, DiscoveryListenerState.Disabled);
        await listener.StopAsync(CancellationToken.None);

        Assert.Equal(DiscoveryListenerState.Disabled, store.Status().State);
    }
}
