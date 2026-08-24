namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Named rate-limit policies, as string constants rather than literals scattered at
/// the call sites — a typo in a policy name on an endpoint is not an error, it just
/// silently applies no policy at all.
/// </summary>
public static class RateLimitPolicies
{
    /// <summary>Login, registration, password reset, PIN — anything that is a guessing oracle.</summary>
    public const string Auth = "auth";

    /// <summary>The device surface. A court box on a 60s heartbeat is nowhere near this ceiling.</summary>
    public const string Device = "device";
}
