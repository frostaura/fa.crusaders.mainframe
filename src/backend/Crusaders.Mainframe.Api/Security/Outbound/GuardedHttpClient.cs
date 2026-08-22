using System.Net;
using System.Net.Sockets;

namespace Crusaders.Mainframe.Api.Security.Outbound;

/// <summary>
/// Wires <see cref="IOutboundAddressGuard"/> into the socket layer of a named
/// <c>HttpClient</c>.
///
/// <para>
/// Validating a URL when it is registered is a usability feature, not a security
/// boundary: the name is resolved minutes or months later, by which time it can point
/// anywhere. A host that answers with a public address for the validation lookup and
/// <c>169.254.169.254</c> for the delivery lookup — DNS rebinding — defeats any
/// check that happens before the connection.
/// </para>
///
/// <para>
/// So the decision is made in <c>ConnectCallback</c>, against the address the socket
/// is about to dial. There is no gap between the check and the connection because it
/// <i>is</i> the connection.
/// </para>
/// </summary>
public static class GuardedHttpClient
{
    public static IHttpClientBuilder AddGuardedHttpClient(this IServiceCollection services, string name)
    {
        return services.AddHttpClient(name)
            .ConfigurePrimaryHttpMessageHandler(sp =>
            {
                var guard = sp.GetRequiredService<IOutboundAddressGuard>();
                var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(GuardedHttpClient));

                return new SocketsHttpHandler
                {
                    // Redirects are not followed. A 302 to the metadata endpoint is the
                    // cheapest way around a guard that only inspects the first hop, and
                    // a webhook receiver has no legitimate reason to redirect.
                    AllowAutoRedirect = false,

                    ConnectTimeout = TimeSpan.FromSeconds(5),
                    PooledConnectionLifetime = TimeSpan.FromMinutes(2),

                    ConnectCallback = async (context, ct) =>
                    {
                        var host = context.DnsEndPoint.Host;
                        var addresses = IPAddress.TryParse(host, out var literal)
                            ? [literal]
                            : await Dns.GetHostAddressesAsync(host, ct);

                        if (addresses.Length == 0)
                        {
                            throw new OutboundBlockedException(host, "dns_no_addresses");
                        }

                        // Every resolved address must pass, not merely one of them. A
                        // name that answers with a public address and a private one is
                        // the rebinding case, and picking the "good" one is the bug.
                        foreach (var address in addresses)
                        {
                            var refusal = guard.Check(address);
                            if (refusal is null) continue;

                            logger.LogWarning(
                                "Blocked outbound connection to {Host} ({Address}): {Reason}", host, address, refusal);

                            throw new OutboundBlockedException(host, refusal);
                        }

                        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                        try
                        {
                            await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, ct);
                            return new NetworkStream(socket, ownsSocket: true);
                        }
                        catch
                        {
                            socket.Dispose();
                            throw;
                        }
                    },
                };
            });
    }
}

/// <summary>
/// Thrown from the connect callback. A distinct type so a blocked destination is
/// reported to the endpoint owner as a configuration problem rather than logged as a
/// transient network failure and retried five more times.
/// </summary>
public sealed class OutboundBlockedException : Exception
{
    public OutboundBlockedException(string host, string reason)
        : base($"Outbound connection to '{host}' was blocked: {reason}")
    {
        Host = host;
        Reason = reason;
    }

    public string Host { get; }
    public string Reason { get; }
}
