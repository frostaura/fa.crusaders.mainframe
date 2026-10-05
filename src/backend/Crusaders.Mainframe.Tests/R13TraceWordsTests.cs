using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, D13-1: a court-box refusal at no court the box maps names the box — and when the
/// box carries only its placeholder name, "the court box" — on EVERY branch. The offline branch did
/// (R12 D12-2); the verdict branch and the used-code branch fell back to "a court".
/// </summary>
public sealed class R13TraceWordsTests
{
    [Theory]
    [InlineData("unresolved", "Was refused at the court box — no booking of theirs on that court then")]
    [InlineData("forgery_suspected", "Was refused at the court box — the code could not be verified")]
    [InlineData(null, "Was refused at the court box")]
    public void A_verdict_at_an_unmapped_relay_of_an_unnamed_box_names_the_court_box(string? verdict, string expected)
    {
        Assert.Equal(expected, TraceKinds.Headline(TraceKinds.CourtRefused, new TraceFacts { Verdict = verdict }));
    }

    [Fact]
    public void A_used_code_at_an_unmapped_relay_of_an_unnamed_box_names_the_court_box()
    {
        Assert.Equal(
            "Was turned away paying for somebody's booking at the court box — code already used",
            TraceKinds.Headline(TraceKinds.CourtRefused, new TraceFacts { CodeUsed = true, Attempt = "pay_for" }));
    }

    /// <summary>The box's own name still wins over the placeholder words, and a mapped court over both.</summary>
    [Fact]
    public void A_named_box_and_a_known_court_are_still_named()
    {
        Assert.Equal(
            "Was refused at East box — no booking of theirs on that court then",
            TraceKinds.Headline(TraceKinds.CourtRefused, new TraceFacts { Verdict = "unresolved", BoxName = "East box" }));
        Assert.Equal(
            "Was refused at Court 2 — no booking of theirs on that court then",
            TraceKinds.Headline(TraceKinds.CourtRefused, new TraceFacts { Verdict = "unresolved", CourtName = "Court 2", BoxName = "East box" }));
    }

    /// <summary>
    /// R13 E13-4: a partner's withdrawal (C13-4's <c>players.withdrew</c>) is a word from each side —
    /// the partner's own ("booking.withdrew") and the organiser's ("booking.partner_withdrew") — never
    /// "no word for this", and each degrades to a true sentence when a name is missing.
    /// </summary>
    [Fact]
    public void A_withdrawal_is_told_from_each_side()
    {
        Assert.Equal(TraceKinds.BookingWithdrew, TraceKinds.OfAudit("players.withdrew", actorIsSubject: true));
        Assert.Equal(TraceKinds.BookingPartnerWithdrew, TraceKinds.OfAudit("players.withdrew", actorIsSubject: false));
        Assert.Equal(TraceKinds.BookingStrand, TraceKinds.StrandOf(TraceKinds.BookingWithdrew));
        Assert.Equal(TraceKinds.BookingStrand, TraceKinds.StrandOf(TraceKinds.BookingPartnerWithdrew));

        Assert.Equal("Withdrew from a game on Court 4",
            TraceKinds.Headline(TraceKinds.BookingWithdrew, new TraceFacts { CourtName = "Court 4" }));
        Assert.Equal("A partner withdrew from their game on Court 4",
            TraceKinds.Headline(TraceKinds.BookingPartnerWithdrew, new TraceFacts { CourtName = "Court 4" }));
    }

    /// <summary>A share movement with no withdrawal behind it keeps its own words, on both sides.</summary>
    [Fact]
    public void A_share_moved_for_any_other_reason_keeps_its_words()
    {
        Assert.Equal("A share of a split booking moved: 7 minutes",
            TraceKinds.Headline(TraceKinds.WalletShareMoved, new TraceFacts { AmountMinutes = -7 }));
        Assert.Equal("A share of a split booking moved for Olive: 7 minutes",
            TraceKinds.Headline(TraceKinds.WalletShareMoved, new TraceFacts { AmountMinutes = -7, OthersMoney = true, SubjectName = "Olive" }));
        Assert.Equal("Olive returned 7 minutes to them — they withdrew from the game",
            TraceKinds.Headline(TraceKinds.WalletShareMoved, new TraceFacts { AmountMinutes = -7, OthersMoney = true, SubjectName = "Olive", WithdrewName = "Sam" }));
        Assert.Equal("Sam got 7 minutes of their share back — they withdrew from the game",
            TraceKinds.Headline(TraceKinds.WalletShareMoved, new TraceFacts { AmountMinutes = 7, OthersMoney = true, SubjectName = "Sam", WithdrewName = "Sam" }));
    }
}
