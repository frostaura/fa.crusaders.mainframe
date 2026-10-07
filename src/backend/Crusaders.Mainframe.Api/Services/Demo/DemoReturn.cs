using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>The demo club an admin is entering and the demo account (mirror admin or member-view persona) they enter as.</summary>
public sealed record DemoEntry(Tenant Club, User Mirror);

/// <summary>Why the way back from the demo is closed, or the real admin it leads to.</summary>
public abstract record DemoReturn
{
    /// <summary>The real admin and club, and the demo account (<paramref name="Mirror"/>) the session is in.</summary>
    public sealed record To(User RealUser, Tenant RealClub, User Mirror) : DemoReturn
    {
        /// <summary>The session is the admin's member-view persona rather than their mirror admin.</summary>
        public bool MemberView => Mirror.DemoMemberView;
    }

    /// <summary>The caller is not a mirror of anybody (not in a demo club, or not its mirror admin).</summary>
    public sealed record NotADemoSession : DemoReturn;

    /// <summary>The real account's sessions were ended (sign out everywhere, a password change, a suspension) since this demo session began.</summary>
    public sealed record SessionEnded : DemoReturn;
}
