namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Named rate-limit policies, as string constants rather than literals scattered at
/// the call sites — a typo in a policy name on an endpoint is not an error, it just
/// silently applies no policy at all.
/// </summary>
public static class RateLimitPolicies
{
    /// <summary>
    /// Registration, PIN and QR matching, code enrolment — anything that is a guessing oracle or
    /// hands a secret out. Ten a minute. Ordinary writes are <see cref="Writes"/>, not this.
    /// </summary>
    public const string Auth = "auth";

    /// <summary>
    /// Sign-in, refresh, sign-out and password reset (review round 1, B14). Anonymous callers are
    /// bucketed by client address at a higher ceiling (<c>RateLimits:AuthPerIpPerMinute</c>, 60)
    /// because a club's Wi-Fi puts every member behind ONE address; the brute-force limit moves to
    /// the account (<see cref="SignInAttempts"/>, <c>AuthPerMinute</c> per address typed). A
    /// cookie-only refresh is bucketed by its cookie, an authenticated call by its member.
    /// </summary>
    public const string SignIn = "sign-in";

    /// <summary>
    /// Booking, players, play and desk WRITES (perf round, 2026-09-30): a member's deliberate
    /// actions, bucketed per member as a token bucket — <c>RateLimits:WritesBurst</c> (20) at once,
    /// refilled at <c>RateLimits:WritesPerMinute</c> (60). They sat on <see cref="Auth"/>, so the
    /// eleventh booking-ish call in a minute — book, invite, accept, cancel, a score — was a 429,
    /// and a cancellation quote spent the budget of the cancel it quoted. None of these is a
    /// guessing oracle; the ceiling is a flood bound, never tighter than the auth one.
    /// </summary>
    public const string Writes = "writes";

    /// <summary>The device surface. A court box on a 60s heartbeat is nowhere near this ceiling.</summary>
    public const string Device = "device";
}
