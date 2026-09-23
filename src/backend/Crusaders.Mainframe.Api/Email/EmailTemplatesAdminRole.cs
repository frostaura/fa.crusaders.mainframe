namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Who changed an administrator's rights, about whom, and why. The revoke's reason is the
/// acting admin's own words and is null on a grant, where none is asked for.
/// </summary>
public sealed record AdminRoleChange
{
    public required string SubjectName { get; init; }
    public required string ActorName { get; init; }
    public required bool Granted { get; init; }
    public string? Reason { get; init; }
    public required string ConsoleUrl { get; init; }
}

/// <summary>
/// The three messages an admin-rights change sends (R20): one to the person it happened to,
/// and a notice to every other administrator.
/// </summary>
/// <remarks>
/// <para>
/// A partial of <see cref="EmailTemplates"/> rather than more lines in it: that file is near a
/// thousand lines of raw-string-dense members, the density <c>memory/gotchas-gates.md</c>
/// records lizard losing its place in. The house rules are unchanged — blocks, never markup,
/// and the club first.
/// </para>
/// <para>
/// <b>Why every other admin is told.</b> Appointing an administrator is the one change that
/// decides who can see and undo every other change, so it must not be possible to do quietly.
/// A club where one admin can add a second, or remove the colleague who would object, without
/// anyone else hearing of it has an admin list nobody can trust.
/// </para>
/// </remarks>
public static partial class EmailTemplates
{
    /// <summary>The person has been made an administrator, and is told what that means.</summary>
    public static EmailMessage AdminRoleGranted(ClubIdentity club, string to, AdminRoleChange change) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "You're now an administrator",
            Preheader: $"{change.ActorName} has given you administrator rights. Sign in again to see the admin console.",
            Heading: "You're now an administrator",
            Blocks:
            [
                new Paragraph($"Hello {change.SubjectName}. {change.ActorName} has made you an administrator at {club.Name}."),
                new Paragraph("You can now approve members, adjust credits, manage courts and devices, and see the club's change record. Everything you do there is recorded against your name."),
                new Callout(CalloutTone.Warning, "If the app is already open, sign out and back in — or wait a few minutes — before the admin console appears."),
                new CallToAction("Open the admin console", change.ConsoleUrl),
                new Paragraph("If you weren't expecting this, tell the club committee."),
            ],
            WhyThis: WhyAccount));

    /// <summary>The person is no longer an administrator, with the reason they were given.</summary>
    public static EmailMessage AdminRoleRevoked(ClubIdentity club, string to, AdminRoleChange change) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "You're no longer an administrator",
            Preheader: "Your membership is unchanged. The reason you were given is inside.",
            Heading: "Your administrator rights have been removed",
            Blocks:
            [
                new Paragraph($"Hello {change.SubjectName}. {change.ActorName} has removed your administrator rights at {club.Name}."),
                new Callout(CalloutTone.Danger, change.Reason ?? "No reason was given."),
                new Paragraph("Your membership, your credits and your bookings are exactly as they were. Only the admin console has gone."),
                new Paragraph("If that looks like a mistake, speak to the club committee."),
            ],
            WhyThis: WhyAccount));

    /// <summary>
    /// Every other administrator's copy. Says who acted, on whom, and — for a removal — why,
    /// because the reader is the person best placed to notice that it was wrong.
    /// </summary>
    public static EmailMessage AdminRoleChangedNotice(ClubIdentity club, string to, AdminRoleChange change) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: change.Granted ? $"New administrator — {change.SubjectName}" : $"Administrator removed — {change.SubjectName}",
            Preheader: change.Granted
                ? $"{change.ActorName} has made {change.SubjectName} an administrator."
                : $"{change.ActorName} has removed {change.SubjectName}'s administrator rights.",
            Heading: change.Granted ? "The club has a new administrator" : "An administrator has been removed",
            Blocks: AdminRoleNoticeBlocks(club, change),
            WhyThis: WhyAdmin));

    private static IReadOnlyList<EmailBlock> AdminRoleNoticeBlocks(ClubIdentity club, AdminRoleChange change)
    {
        var what = change.Granted
            ? $"{change.ActorName} has made {change.SubjectName} an administrator at {club.Name}."
            : $"{change.ActorName} has removed {change.SubjectName}'s administrator rights at {club.Name}.";

        var facts = new List<FactRow>
        {
            new("Member", change.SubjectName),
            new("Changed by", change.ActorName),
        };
        if (!change.Granted) facts.Add(new FactRow("Reason", change.Reason ?? "No reason was given."));

        return
        [
            new Paragraph(what),
            new Facts(facts),
            new Paragraph("Every administrator is told about every change to who administers the club. If you didn't expect this one, check with the committee."),
            new CallToAction("Open the change record", change.ConsoleUrl),
        ];
    }
}
