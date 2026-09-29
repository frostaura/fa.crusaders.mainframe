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

    /// <summary>
    /// Sign-in, refresh, sign-out and password reset (review round 1, B14). Anonymous callers are
    /// bucketed by client address at a higher ceiling (<c>RateLimits:AuthPerIpPerMinute</c>, 60)
    /// because a club's Wi-Fi puts every member behind ONE address; the brute-force limit moves to
    /// the account (<see cref="SignInAttempts"/>, <c>AuthPerMinute</c> per address typed). A
    /// cookie-only refresh is bucketed by its cookie, an authenticated call by its member.
    /// </summary>
    public const string SignIn = "sign-in";

    /// <summary>The device surface. A court box on a 60s heartbeat is nowhere near this ceiling.</summary>
    public const string Device = "device";
}
