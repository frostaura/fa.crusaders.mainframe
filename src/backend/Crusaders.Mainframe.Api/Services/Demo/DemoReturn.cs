using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>The demo club an admin is entering and the mirror admin they enter as.</summary>
public sealed record DemoEntry(Tenant Club, User Mirror);

/// <summary>Why the way back from the demo is closed, or the real admin it leads to.</summary>
public abstract record DemoReturn
{
    public sealed record To(User RealUser, Tenant RealClub) : DemoReturn;

    /// <summary>The caller is not a mirror of anybody (not in a demo club, or not its mirror admin).</summary>
    public sealed record NotADemoSession : DemoReturn;

    /// <summary>The real account's sessions were ended (sign out everywhere, a password change, a suspension) since this demo session began.</summary>
    public sealed record SessionEnded : DemoReturn;
}
