using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D11's target rule, row by row: what a partner should have paid the organiser for one booking,
/// given the seat and the organiser's <c>Owed</c>. A 32-credit court, a 10-credit share.
/// </summary>
public class ShareRulesTests
{
    private static ShareFacts Facts(
        ParticipantStatus status = ParticipantStatus.Accepted, bool partner = true, bool outside = false,
        int share = 10, int consent = 10, BookingStatus booking = BookingStatus.Booked,
        bool checkedIn = false, bool displaced = false, int owed = 32, int paid = 0, bool closed = false) =>
        new(status, partner, outside, share, consent, booking, checkedIn, displaced, 32, owed, paid, closed);

    public static TheoryData<string, ShareFacts, decimal> Table => new()
    {
        { "a live game is shared in full", Facts(), 10 },
        { "a played game is shared in full", Facts(booking: BookingStatus.Completed, checkedIn: true), 10 },
        { "the organiser takes no share from themselves", Facts(partner: false), 0 },
        { "an invite nobody accepted pays nothing", Facts(ParticipantStatus.Invited), 0 },
        { "a declined seat pays nothing", Facts(ParticipantStatus.Declined), 0 },
        { "a withdrawn seat is refunded", Facts(ParticipantStatus.Withdrawn), 0 },
        { "a removed seat is refunded", Facts(ParticipantStatus.Removed), 0 },
        { "a lapsed seat pays nothing", Facts(ParticipantStatus.Lapsed), 0 },
        { "a share settled outside the app is not collected", Facts(outside: true), 0 },
        // P13-B3: the rows below with a fractional Owed (9.6) or a cent-rounded target (3.12) were
        // removed for compile; restate them in whole minutes (floor, §1.2):
        //   cancelled game refunds every partner (owed 9.6 → 0) · no-show penalty pro rata (owed 9.6 → 3)
        //   fraction rounds DOWN (owed 10, share 10 → 3.12) · lapsed seat return (owed 9.6, paid 10, closed → 3)
        { "a game cancelled after check-in is still shared", Facts(booking: BookingStatus.Cancelled, checkedIn: true), 10 },
        { "a no-show with no penalty (S5a) is free for everybody", Facts(booking: BookingStatus.NoShow, owed: 0), 0 },
        { "a displaced game is free", Facts(booking: BookingStatus.Cancelled, displaced: true, owed: 0), 0 },
        { "a raised share is capped at the consent", Facts(share: 16, consent: 10), 10 },
        { "an admin's accept (no consent) collects nothing", Facts(consent: 0), 0 },
        { "Owed above the price is clamped (defensive)", Facts(owed: 40), 10 },
        { "a negative Owed is clamped to nothing", Facts(owed: -5), 0 },
        { "an open seat is collected past what it has paid so far", Facts(paid: 4), 10 },
        { "a lapsed seat never collects past what it paid", Facts(paid: 4, closed: true), 4 },
        { "a lapsed seat that paid nothing collects nothing", Facts(closed: true), 0 },
        { "a lapsed seat fully paid keeps its share", Facts(paid: 10, closed: true), 10 },
    };

    [Theory]
    [MemberData(nameof(Table))]
    public void The_target_rule(string because, ShareFacts facts, decimal expected)
    {
        Assert.True(expected == ShareRules.TargetFor(facts), because);
    }

    [Fact]
    public void An_admin_block_is_never_shared()
    {
        Assert.Equal(0, ShareRules.TargetFor(Facts(booking: BookingStatus.AdminBlock)));
    }

    /// <summary>
    /// The partners' targets never sum past what the organiser owes, whatever <c>Owed</c> is —
    /// the rounding is toward zero on every seat, so the organiser is never paid more than the court.
    /// </summary>
    [Fact]
    public void Partner_targets_never_exceed_what_the_organiser_owes()
    {
        var random = new Random(911);
        for (var i = 0; i < 2000; i++)
        {
            var price = random.Next(1, 201);
            var owed = random.Next(0, price + 1);
            var split = SplitCalculator.Split(price, SplitModes.Equal,
                Enumerable.Range(1, random.Next(2, 5)).Select(s => new SplitSeat(s, false)).ToList()).Shares!;
            var total = split.Where(s => s.Seat > 1).Sum(s => ShareRules.TargetFor(new ShareFacts(
                ParticipantStatus.Accepted, true, false, s.ShareMinutes, s.ShareMinutes, BookingStatus.NoShow, false, false, price, owed)));
            Assert.True(total <= owed, $"case {i}: partners {total} > owed {owed}");
        }
    }
}
