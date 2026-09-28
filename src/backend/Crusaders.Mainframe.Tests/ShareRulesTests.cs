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
        decimal share = 10m, decimal consent = 10m, BookingStatus booking = BookingStatus.Booked,
        bool checkedIn = false, bool displaced = false, decimal owed = 32m) =>
        new(status, partner, outside, share, consent, booking, checkedIn, displaced, 32m, owed);

    public static TheoryData<string, ShareFacts, decimal> Table => new()
    {
        { "a live game is shared in full", Facts(), 10m },
        { "a played game is shared in full", Facts(booking: BookingStatus.Completed, checkedIn: true), 10m },
        { "the organiser takes no share from themselves", Facts(partner: false), 0m },
        { "an invite nobody accepted pays nothing", Facts(ParticipantStatus.Invited), 0m },
        { "a declined seat pays nothing", Facts(ParticipantStatus.Declined), 0m },
        { "a withdrawn seat is refunded", Facts(ParticipantStatus.Withdrawn), 0m },
        { "a removed seat is refunded", Facts(ParticipantStatus.Removed), 0m },
        { "a lapsed seat pays nothing", Facts(ParticipantStatus.Lapsed), 0m },
        { "a share settled outside the app is not collected", Facts(outside: true), 0m },
        { "a cancelled game refunds every partner (the late penalty is the organiser's)", Facts(booking: BookingStatus.Cancelled, owed: 9.6m), 0m },
        { "a game cancelled after check-in is still shared", Facts(booking: BookingStatus.Cancelled, checkedIn: true), 10m },
        { "a no-show's penalty is shared pro rata", Facts(booking: BookingStatus.NoShow, owed: 9.6m), 3m },
        { "a no-show with no penalty (S5a) is free for everybody", Facts(booking: BookingStatus.NoShow, owed: 0m), 0m },
        { "a displaced game is free", Facts(booking: BookingStatus.Cancelled, displaced: true, owed: 0m), 0m },
        { "a raised share is capped at the consent", Facts(share: 16m, consent: 10m), 10m },
        { "an admin's accept (no consent) collects nothing", Facts(consent: 0m), 0m },
        { "the fraction rounds DOWN to the cent", Facts(owed: 10m, share: 10m), 3.12m },
        { "Owed above the price is clamped (defensive)", Facts(owed: 40m), 10m },
        { "a negative Owed is clamped to nothing", Facts(owed: -5m), 0m },
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
        Assert.Equal(0m, ShareRules.TargetFor(Facts(booking: BookingStatus.AdminBlock)));
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
            var price = Math.Round((decimal)random.NextDouble() * 200m + 1m, 2);
            var owed = Math.Round((decimal)random.NextDouble() * price, 2);
            var split = SplitCalculator.Split(price, SplitModes.Equal,
                Enumerable.Range(1, random.Next(2, 5)).Select(s => new SplitSeat(s, false)).ToList()).Shares!;
            var total = split.Where(s => s.Seat > 1).Sum(s => ShareRules.TargetFor(new ShareFacts(
                ParticipantStatus.Accepted, true, false, s.ShareCredits, s.ShareCredits, BookingStatus.NoShow, false, false, price, owed)));
            Assert.True(total <= owed, $"case {i}: partners {total} > owed {owed}");
        }
    }
}
