using Crusaders.Mainframe.Api.Email;

namespace Crusaders.Mainframe.Tests;

/// <summary>Review round 13, lane BE13b: mail sentences that promised or omitted something (J13-7, J13-9).</summary>
public sealed class R13MailWordsTests
{
    private static string Flat(string? text) => System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ");

    /// <summary>
    /// J13-7: "the club put you in X's game" promised nothing would be taken until the member accepted
    /// — but an admin's Collect takes it. The sentence now says both ways a share moves.
    /// </summary>
    [Fact]
    public void The_club_seat_mail_does_not_promise_what_a_club_collect_breaks()
    {
        var mail = EmailTemplates.ClubSeat(EmailCatalogue.Riverside, "s@x.review.test",
            new ClubSeatNotice("Olive Organiser", "Court 1", "Sat 3 Oct, 10:00", 16, Accepted: true, "https://x.review.test/bookings/b"));
        var body = Flat(mail.PlainBody) + Flat(mail.HtmlBody);

        Assert.DoesNotContain("Nothing is taken from your balance for your share until you accept it yourself", body, StringComparison.Ordinal);
        Assert.Contains("Your share is not taken automatically: it moves when you accept it in the app, or if the club collects it — you get a receipt either way.", body, StringComparison.Ordinal);
    }

    /// <summary>J13-9: the revoke mail's reason is labelled as the grant mail's is.</summary>
    [Theory]
    [InlineData("Stepped down from the committee", "Stepped down from the committee")]
    [InlineData(null, "No reason was given.")]
    public void The_revoke_mail_labels_its_reason(string? reason, string said)
    {
        var change = new AdminRoleChange
        {
            SubjectName = "Sam Partner", ActorName = "Ada Admin", Granted = false, Reason = reason, ConsoleUrl = "https://x.review.test/admin",
        };
        var revoked = Flat(EmailTemplates.AdminRoleRevoked(EmailCatalogue.Riverside, "s@x.review.test", change).PlainBody);
        var granted = Flat(EmailTemplates.AdminRoleGranted(EmailCatalogue.Riverside, "s@x.review.test",
            change with { Granted = true, Reason = "Runs the bar" }).PlainBody);

        Assert.Contains("Reason: Runs the bar", granted, StringComparison.Ordinal);
        Assert.Contains($"Reason: {said}", revoked, StringComparison.Ordinal);
    }
}
