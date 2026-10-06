namespace Crusaders.Mainframe.Api.Email;

/// <summary>What one member's deletion was, as the two messages about it say it.</summary>
public sealed record MemberDeletedNotice
{
    public required string SubjectName { get; init; }
    public required string ActorName { get; init; }
    public required string Reason { get; init; }

    /// <summary>True when the history stayed and the person was erased from it; false when every row went.</summary>
    public required bool KeptHistory { get; init; }

    /// <summary>Bookings of theirs that had not started and were cancelled with a full refund.</summary>
    public int BookingsCancelled { get; init; }

    /// <summary>The balance left after the refunds that the club wrote off; 0 when there was none.</summary>
    public int WrittenOffMinutes { get; init; }

    public string ConsoleUrl { get; init; } = "";
}

/// <summary>
/// The two messages a member's deletion sends: the member's own, mailed before their address is
/// wiped and only to a member the club had admitted at an address they confirmed, and every other
/// administrator's notice (an admin notice, so it rides the outbox with the deletion's own save).
/// </summary>
public static partial class EmailTemplates
{
    /// <summary>The member is told their account is gone, why, and that their sign-in no longer works.</summary>
    public static EmailMessage MemberAccountDeleted(ClubIdentity club, string to, MemberDeletedNotice d) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Your account has been deleted",
            Preheader: $"{club.Name} has deleted your account. The reason you were given is inside.",
            Heading: "Your account has been deleted",
            Blocks:
            [
                new Paragraph($"Hello {d.SubjectName}. {club.Name} has deleted your account, so you can no longer sign in, book a court, or open a court or the door with your member code."),
                new Facts(MemberDeletedFacts(d)),
                new Paragraph("Your name, email address, photo and sign-in details have been removed. You can apply to join again with the same email address."),
                new Paragraph("If that looks like a mistake, speak to the club committee."),
            ],
            WhyThis: WhyMembership));

    /// <summary>Every other administrator's copy: who acted, on whom, why, and what it did to the books.</summary>
    public static EmailMessage AdminMemberDeletedNotice(ClubIdentity club, string to, MemberDeletedNotice d) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Member deleted — {d.SubjectName}",
            Preheader: $"{d.ActorName} has deleted {d.SubjectName}'s account.",
            Heading: "A member has been deleted",
            Blocks:
            [
                new Paragraph($"{d.ActorName} has deleted {d.SubjectName}'s account at {club.Name}."),
                new Facts(AdminDeletedFacts(d)),
                new Paragraph(d.KeptHistory
                    ? "Their bookings and minutes stay on the club's books under the name \"Deleted member\", so the reports still add up."
                    : "They had no bookings and no minutes, so nothing of theirs is left on the club's books."),
                new CallToAction("Open the change record", d.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    private static IReadOnlyList<FactRow> MemberDeletedFacts(MemberDeletedNotice d)
    {
        var rows = new List<FactRow> { new("Reason", d.Reason) };
        if (d.BookingsCancelled > 0)
        {
            rows.Add(new FactRow("Bookings cancelled", $"{d.BookingsCancelled}, each refunded in full"));
        }
        if (d.WrittenOffMinutes != 0) rows.Add(new FactRow("Minutes written off", Min(d.WrittenOffMinutes)));
        return rows;
    }

    private static IReadOnlyList<FactRow> AdminDeletedFacts(MemberDeletedNotice d)
    {
        var rows = new List<FactRow>
        {
            new("Member", d.SubjectName),
            new("Deleted by", d.ActorName),
            new("Reason", d.Reason),
        };
        if (d.BookingsCancelled > 0) rows.Add(new FactRow("Bookings cancelled", d.BookingsCancelled.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        if (d.WrittenOffMinutes != 0) rows.Add(new FactRow("Minutes written off", Min(d.WrittenOffMinutes)));
        return rows;
    }
}
