namespace Crusaders.Mainframe.Api.Lights;

/// <summary>The outcome of asking a court box to change a relay.</summary>
public sealed record RelayResult(bool Ok, string? FailureReason)
{
    public static RelayResult Success() => new(true, null);
    public static RelayResult Failed(string reason) => new(false, reason);
}

/// <summary>
/// Drives a court's lights.
///
/// <para>
/// <b>Deliberately not on the webhook bus.</b> That bus is a single global serial
/// dispatcher with a 10-second per-endpoint timeout and a per-endpoint queue, built for
/// mirroring events to arbitrary third parties. A member standing at a dark court needs an
/// answer in about a second, and one slow unrelated webhook endpoint would sit in front of
/// them in the queue. The webhook system stays what it is good at — the monitoring mirror
/// — and actuation goes on the request path.
/// </para>
///
/// <para>
/// <b>Every call carries a duration.</b> There is no way to ask for lights-on indefinitely,
/// mirroring the wire protocol, which makes the same thing unrepresentable. Today nothing
/// in the hardware turns the lights off if the controller dies: the off command is
/// scheduled inside a VBA macro on a Windows PC, so a sleeping laptop leaves a court
/// burning. The device holds its own independent timer, and this interface is shaped so a
/// caller cannot fail to give it one.
/// </para>
/// </summary>
public interface IRelayClient
{
    /// <summary>
    /// Turns a court's lights on for at most <paramref name="duration"/>.
    /// </summary>
    /// <param name="idempotencyKey">
    /// Repeated calls with the same key are one actuation. The court box may be retried
    /// after a timeout it actually received, and a member must not be charged or
    /// double-cued because a response was lost.
    /// </param>
    Task<RelayResult> TurnOnAsync(int courtNumber, TimeSpan duration, string idempotencyKey, CancellationToken ct);

    Task<RelayResult> TurnOffAsync(int courtNumber, string idempotencyKey, CancellationToken ct);
}

/// <summary>
/// The default. Records what it was asked to do and reports success.
///
/// <para>
/// <b>Not registered in the container</b>, in <c>Program.cs</c> or <c>TestHost.cs</c>. It
/// was, with no injection site anywhere — and a registration nothing resolves is a claim
/// that the API actuates lights when the court box is pull-only and does its own switching
/// (original review A2-16). The type stays because the invariant is that hardware
/// abstractions ship before drivers: this is the shape any future API-driven actuation has
/// to take, and <c>LightsCueTests</c> constructs it directly to pin that every overload
/// carries a duration. Register it in the same commit as the first caller, not before.
/// </para>
///
/// <para>
/// It reports success rather than failure on purpose. A null driver that failed would make
/// every booking path exercise its error branch in development and in every test that did
/// not think about lights, which trains people to ignore the error branch.
/// </para>
/// </summary>
public sealed class NullRelayClient : IRelayClient
{
    private readonly ILogger<NullRelayClient> _logger;

    public NullRelayClient(ILogger<NullRelayClient> logger) => _logger = logger;

    public Task<RelayResult> TurnOnAsync(int courtNumber, TimeSpan duration, string idempotencyKey, CancellationToken ct)
    {
        _logger.LogInformation(
            "NullRelayClient: court {Court} ON for {Seconds}s (key {Key}) — no hardware attached",
            courtNumber, (int)duration.TotalSeconds, idempotencyKey);

        return Task.FromResult(RelayResult.Success());
    }

    public Task<RelayResult> TurnOffAsync(int courtNumber, string idempotencyKey, CancellationToken ct)
    {
        _logger.LogInformation(
            "NullRelayClient: court {Court} OFF (key {Key}) — no hardware attached", courtNumber, idempotencyKey);

        return Task.FromResult(RelayResult.Success());
    }
}
