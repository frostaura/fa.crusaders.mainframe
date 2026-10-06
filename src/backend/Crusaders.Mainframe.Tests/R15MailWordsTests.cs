using Crusaders.Mainframe.Api.Email;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 15, lane BE15b — what the players mails say:
/// <list type="bullet">
/// <item>E15-1: the club cancelling a session that had started (nothing refunded) mailed the partner
/// "any share you paid comes back … you will get a separate receipt" — it stands.</item>
/// <item>J15-11: "Court 4 at Tue 13 Oct, 06:00" (now "Court 4 on Tue 13 Oct at 06:00"), and a minutes
/// figure with a singular verb ("15 minutes was taken").</item>
/// <item>E15-8: a share mail on the organiser's side said "Share returned to Sam" with no cause, the
/// partner's own withdrawal was titled "Share refunded", and the club's settle-outside omitted the reason.</item>
/// <item>J15-9: a split change to a partner the club had settled outside the app said "Your share now:
/// 20 minutes" as if it would be taken. J15-5: the re-collection after a late check-in named nobody.</item>
/// </list>
/// </summary>
public sealed class R15MailWordsTests
{
    private const string To = "s@x.review.test";
    private const string Url = "https://x.review.test/bookings/b";
    private const string When = "Tue 13 Oct, 06:00";

    private static string Flat(string? text) => System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ");

    private static string All(EmailMessage m) => Flat(m.PlainBody) + " " + Flat(m.HtmlBody);

    // ------------------------------------------------------------------ E15-1

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_started_sessions_cancellation_says_the_share_stands_and_promises_no_receipt(bool byClub)
    {
        var mail = EmailTemplates.PlayersBookingCancelled(EmailCatalogue.Riverside, To,
            new CancelledGame("Olive Organiser", "Court 1", When, SessionStarted: true), new GameCancelledBy(byClub, byClub ? "Flooded court" : null, null));
        var text = All(mail);

        Assert.Contains("The session had started, so any share you paid stands", text, StringComparison.Ordinal);
        Assert.DoesNotContain("comes back", text, StringComparison.Ordinal);
        Assert.DoesNotContain("separate receipt", text, StringComparison.Ordinal);
    }

    [Fact]
    public void A_cancellation_before_the_start_still_says_the_share_comes_back()
    {
        var text = All(EmailTemplates.PlayersBookingCancelled(EmailCatalogue.Riverside, To, "Olive Organiser", "Court 1", When,
            new GameCancelledBy(false, null, null)));

        Assert.Contains("Any share you paid comes back to you.", text, StringComparison.Ordinal);
        Assert.DoesNotContain("stands", text, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ J15-11: court and day

    [Fact]
    public void A_court_and_its_start_read_on_the_day_at_the_time()
    {
        var change = EmailTemplates.PlayersChanged(EmailCatalogue.Riverside, To,
            new PlayersChange("Olive Organiser", "Court 4", When, Removed: false, NewShareMinutes: 20, NeedsConsent: false, Url));
        var cancelled = EmailTemplates.PlayersBookingCancelled(EmailCatalogue.Riverside, To, "Olive Organiser", "Court 4", When,
            new GameCancelledBy(false, null, null));
        var removed = EmailTemplates.PlayersChanged(EmailCatalogue.Riverside, To,
            new PlayersChange("Olive Organiser", "Court 4", When, Removed: true, NewShareMinutes: null, NeedsConsent: false, Url));

        Assert.Contains("Olive Organiser has changed how Court 4 on Tue 13 Oct at 06:00 is split.", Flat(change.PlainBody), StringComparison.Ordinal);
        Assert.Contains("Olive Organiser has cancelled the booking for Court 4 on Tue 13 Oct at 06:00.", Flat(cancelled.PlainBody), StringComparison.Ordinal);
        Assert.Contains("the booking for Court 4 on Tue 13 Oct at 06:00.", Flat(removed.PlainBody), StringComparison.Ordinal);
        foreach (var m in new[] { change, cancelled, removed })
        {
            Assert.DoesNotContain("Court 4 at Tue", All(m), StringComparison.Ordinal);
        }
    }

    // ------------------------------------------------------------------ J15-11: verbs agree with the figure

    [Theory]
    [InlineData(15, "15 minutes were taken from your balance again")]
    [InlineData(1, "1 minute was taken from your balance again")]
    public void A_minutes_figure_takes_a_verb_that_agrees(int minutes, string said)
    {
        var mail = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, To,
            new ShareMovement(ShareDirection.Paid, "Olive Organiser", "Court 1", When, minutes, Url) { AfterAttendance = true });

        Assert.Contains(said, Flat(mail.PlainBody), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(15, "15 minutes are on their way back — Court 1")]
    [InlineData(1, "1 minute is on its way back — Court 1")]
    public void A_waiting_return_agrees_with_its_figure(int minutes, string subject)
    {
        var mail = EmailTemplates.ShareReturnWaiting(EmailCatalogue.Riverside, To,
            new ShareReturnWaitingNotice("Olive Organiser", "Court 1", When, minutes, ToOrganiser: false, Url));

        Assert.Equal(subject, mail.Subject);
        Assert.Contains($"{(minutes == 1 ? "1 minute" : $"{minutes} minutes")} of your share for Court 1 on Tue 13 Oct at 06:00 {(minutes == 1 ? "is" : "are")} due back to you",
            Flat(mail.PlainBody), StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ E15-8: share mails say why

    [Theory]
    [InlineData(ShareActs.OrganiserRemoved, null, "Share returned to Sam Partner: you took them off the game — Court 1")]
    [InlineData(ShareActs.SplitChanged, null, "Share returned to Sam Partner: you lowered their share — Court 1")]
    [InlineData(ShareActs.ClubSettled, null, "Share returned to Sam Partner: the club recorded it as paid by hand — Court 1")]
    [InlineData(ShareActs.BookingCancelled, "club", "Share returned to Sam Partner: the club cancelled the game — Court 1")]
    [InlineData(ShareActs.BookingCancelled, "member", "Share returned to Sam Partner: you cancelled the game — Court 1")]
    public void The_organisers_share_subject_says_why_it_went_back(string cause, string? cancelledBy, string subject)
    {
        var mail = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, To,
            new ShareMovement(ShareDirection.Returned, "Sam Partner", "Court 1", When, 7, Url) { Cause = cause, CancelledBy = cancelledBy });

        Assert.Equal(subject, mail.Subject);
    }

    [Fact]
    public void A_withdrawal_is_titled_as_one_on_both_sides()
    {
        var mine = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, To,
            new ShareMovement(ShareDirection.Refunded, "Olive Organiser", "Court 1", When, 7, Url) { Withdrew = true });
        var theirs = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, To,
            new ShareMovement(ShareDirection.Returned, "Sam Partner", "Court 1", When, 7, Url) { Withdrew = true });

        Assert.Equal("Your share came back: you withdrew — Court 1", mine.Subject);
        Assert.Equal("Share returned to Sam Partner: they withdrew — Court 1", theirs.Subject);
    }

    [Theory]
    [InlineData(ShareDirection.Refunded)]
    [InlineData(ShareDirection.Returned)]
    public void The_clubs_settle_outside_mail_carries_the_desks_reason(ShareDirection side)
    {
        var mail = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, To,
            new ShareMovement(side, "Sam Partner", "Court 1", When, 7, Url) { Cause = ShareActs.ClubSettled, ClubReason = "Paid cash at the bar" });

        Assert.Contains("Reason given by the club: Paid cash at the bar", Flat(mail.PlainBody), StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ J15-9: a settled partner's split change

    [Fact]
    public void A_split_change_to_a_share_the_club_settled_says_nothing_moves_in_the_app()
    {
        var mail = EmailTemplates.PlayersChanged(EmailCatalogue.Riverside, To,
            new PlayersChange("Olive Organiser", "Court 1", When, Removed: false, NewShareMinutes: 20, NeedsConsent: false, Url) { SettledOutside = true });
        var body = Flat(mail.PlainBody);

        Assert.Contains("The club has recorded your share as paid by hand, so nothing is taken or returned in the app for this change.",
            body, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ J15-5: the re-collection names the scanner

    [Theory]
    [InlineData(ShareDirection.Paid, "Owen Organiser's check-in has since come through")]
    [InlineData(ShareDirection.Received, "Owen Organiser's check-in has since come through")]
    public void A_share_taken_again_names_whose_check_in_it_was(ShareDirection side, string said)
    {
        var mail = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, To,
            new ShareMovement(side, "Sam Partner", "Court 1", When, 7, Url) { AfterAttendance = true, ScannerName = "Owen Organiser" });

        Assert.Contains(said, Flat(mail.PlainBody), StringComparison.Ordinal);
        Assert.DoesNotContain("the court's check-in", Flat(mail.PlainBody), StringComparison.Ordinal);
    }
}
