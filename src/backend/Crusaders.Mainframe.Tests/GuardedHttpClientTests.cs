using System.Net;
using System.Net.Sockets;
using Crusaders.Mainframe.Api.Security.Outbound;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The guard at the socket, not in a unit.
///
/// <para>
/// <see cref="OutboundGuardTests"/> proves the classification logic. This proves the
/// wiring — that the decision is actually reached on the path a webhook takes, against
/// a real listener that really is up. A correct guard that was never plugged into
/// <c>ConnectCallback</c> would pass every test in the other file.
/// </para>
/// </summary>
public class GuardedHttpClientTests : IDisposable
{
    private readonly TcpListener _listener;
    private readonly int _port;
    private readonly CancellationTokenSource _cts = new();

    public GuardedHttpClientTests()
    {
        // A real listener on loopback. If the guard is absent the request succeeds and
        // the test fails on a 200 — a much stronger signal than a connection refused,
        // which would look identical to a guard that works.
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        _port = ((IPEndPoint)_listener.LocalEndpoint).Port;

        _ = Task.Run(async () =>
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    using var client = await _listener.AcceptTcpClientAsync(_cts.Token);
                    await using var stream = client.GetStream();
                    var response = "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret"u8.ToArray();
                    await stream.WriteAsync(response, _cts.Token);
                }
                catch (OperationCanceledException) { return; }
                catch (SocketException) { return; }
                catch (ObjectDisposedException) { return; }
            }
        });
    }

    private static HttpClient ClientWith(bool allowPrivate, string[]? allowList = null)
    {
        var settings = new Dictionary<string, string?>
        {
            ["Webhooks:AllowPrivateNetworks"] = allowPrivate ? "true" : "false",
        };

        for (var i = 0; i < (allowList?.Length ?? 0); i++)
        {
            settings[$"Webhooks:PrivateNetworkAllowList:{i}"] = allowList![i];
        }

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(settings).Build());
        services.AddSingleton<IHostEnvironment>(new ProductionEnvironment());
        services.AddSingleton<IOutboundAddressGuard, OutboundAddressGuard>();
        services.AddGuardedHttpClient("webhooks");

        return services.BuildServiceProvider()
            .GetRequiredService<IHttpClientFactory>()
            .CreateClient("webhooks");
    }

    /// <summary>
    /// The attack, executed. A member registers a webhook at a loopback service and the
    /// server must not fetch it — not fetch it and hide the body, but not fetch it.
    /// </summary>
    [Fact]
    public async Task A_loopback_destination_is_blocked_at_the_socket()
    {
        using var client = ClientWith(allowPrivate: false);

        var ex = await Assert.ThrowsAsync<HttpRequestException>(
            () => client.GetAsync($"http://127.0.0.1:{_port}/"));

        Assert.Contains(Unwrap(ex), e => e is OutboundBlockedException);
    }

    /// <summary>The control: the same listener, reachable once the guard permits it.</summary>
    [Fact]
    public async Task The_same_destination_succeeds_when_it_is_permitted()
    {
        using var client = ClientWith(allowPrivate: true);

        var response = await client.GetAsync($"http://127.0.0.1:{_port}/");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("secret", await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// The carve-out reaching a live socket, which is the thing the lights controller
    /// actually needs and the reason CLAUDE.md forbids closing it.
    /// </summary>
    [Fact]
    public async Task An_allow_listed_destination_reaches_a_live_socket()
    {
        using var client = ClientWith(allowPrivate: false, allowList: ["127.0.0.1/32"]);

        var response = await client.GetAsync($"http://127.0.0.1:{_port}/");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    /// <summary>
    /// An IPv4-mapped IPv6 literal for the same loopback address. The standard way past
    /// a guard that only knows how to read IPv4.
    /// </summary>
    [Fact]
    public async Task An_ipv4_mapped_literal_does_not_get_around_the_guard()
    {
        using var client = ClientWith(allowPrivate: false);

        var ex = await Assert.ThrowsAsync<HttpRequestException>(
            () => client.GetAsync($"http://[::ffff:127.0.0.1]:{_port}/"));

        // Asserting the specific exception, not merely that something threw. An earlier
        // draft asserted HttpRequestException alone and passed with the guard disabled —
        // the mapped literal fails to connect for its own reasons on this stack, so the
        // weaker assertion was evidence of nothing.
        Assert.Contains(Unwrap(ex), e => e is OutboundBlockedException);
    }

    /// <summary>
    /// Redirects are not followed. A public URL answering 302 to the metadata endpoint
    /// is the cheapest way around a guard that only inspects the first hop, and a
    /// webhook receiver has no legitimate reason to redirect.
    /// </summary>
    [Fact]
    public async Task Redirects_are_not_followed()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        _ = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync();
            await using var stream = client.GetStream();
            await stream.WriteAsync(
                "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"u8.ToArray());
        });

        using var http = ClientWith(allowPrivate: true);   // permitted, so only the redirect rule is under test
        var response = await http.GetAsync($"http://127.0.0.1:{port}/");

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        listener.Stop();
    }

    /// <summary>Production, so the guard's default is the restrictive one.</summary>
    private sealed class ProductionEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Production";
        public string ApplicationName { get; set; } = "tests";
        public string ContentRootPath { get; set; } = ".";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } =
            new Microsoft.Extensions.FileProviders.NullFileProvider();
    }

    private static IEnumerable<Exception> Unwrap(Exception? ex)
    {
        for (var depth = 0; ex is not null && depth < 5; depth++, ex = ex.InnerException)
        {
            yield return ex;
        }
    }

    public void Dispose()
    {
        _cts.Cancel();
        _listener.Stop();
        _cts.Dispose();
        GC.SuppressFinalize(this);
    }
}
