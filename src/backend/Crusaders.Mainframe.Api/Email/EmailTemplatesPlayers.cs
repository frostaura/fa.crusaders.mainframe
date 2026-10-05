namespace Crusaders.Mainframe.Api.Email;

/// <summary>A game somebody has been asked to join, and what their share of it would be.</summary>
public sealed record PlayerInviteNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, string AcceptUrl);

/// <summary>Which way a share moved, from the reader's side of it.</summary>
public enum ShareDirection
{
    /// <summary>The reader paid their share to the organiser.</summary>
    Paid,

    /// <summary>The reader (the organiser) received a partner's share.</summary>
    Received,

    /// <summary>The reader's share came back to them.</summary>
    Refunded,

    /// <summary>The reader (the organiser) handed a partner's share back.</summary>
    Returned,
}

/// <summary>One share movement, as the person on one side of it reads it.</summary>
/// <param name="HeldUntilLocal">
/// A share an organiser RECEIVES is held until the booking's share deadline (D11) — "added to your
/// balance" alone read as money they could spend now (review round 1, B12).
/// </param>
/// <param name="ByClub">The club collected it (an admin's collect), not the partner (B8).</param>
/// <param name="BalanceAfterMinutes">The partner's balance after a club collect — said when it is below zero (B8).</param>
public sealed record ShareMovement(
    ShareDirection Direction, string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes, string BookingUrl,
    string? HeldUntilLocal = null, bool ByClub = false, int? BalanceAfterMinutes = null)
{
    /// <summary>The club took the partner off the game and this is the share going back (review round 2, B-8).</summary>
    public bool ClubRemoved { get; init; }

    /// <summary>The reason the admin recorded for a club collect or removal — the adjust mail always carried one (B-8).</summary>
    public string? ClubReason { get; init; }

    /// <summary>
    /// The share was taken again because the booking's refund was reversed — the court's late
    /// check-in showed the session was attended (review round 9, E9-2). A plain "You paid your
    /// share" told the partner nothing about why minutes left their balance for a refunded game.
    /// </summary>
    public bool AfterAttendance { get; init; }

    /// <summary>
    /// Review round 10, E10-7: the share went back because the CLUB refunded the session — one of
    /// <see cref="ShareRefundCauses"/> — not because the organiser returned it. Null otherwise.
    /// </summary>
    public string? ClubRefund { get; init; }

    /// <summary>
    /// Review round 11, E11-2: on a no-show return, the partner's part of the no-show penalty — the
    /// minutes of their share that did NOT come back. Null when nothing was kept. "The club refunded
    /// the session" alone left a partner who paid 15 and got 11 back with 4 unexplained.
    /// </summary>
    public int? KeptMinutes { get; init; }

    /// <summary>A no-show return that kept part of the share (E11-2).</summary>
    public bool KeptForNoShow => ClubRefund == ShareRefundCauses.NoShow && KeptMinutes is > 0;

    /// <summary>Review round 13, E13-4: the share went back because the partner withdrew from the game.</summary>
    public bool Withdrew { get; init; }

    /// <summary>
    /// R14 X14-2 / J14-8: why it went back, when the mail words it — <see cref="ShareActs.OrganiserRemoved"/>,
    /// <see cref="ShareActs.SplitChanged"/> or <see cref="ShareActs.BookingCancelled"/>. Null otherwise.
    /// </summary>
    public string? Cause { get; init; }

    /// <summary>R14 J14-8: with a cancellation, "club" or "member"; null when unrecorded.</summary>
    public string? CancelledBy { get; init; }

    /// <summary>
    /// R15 J15-5: on a share taken again after a late check-in (<see cref="AfterAttendance"/>), whose
    /// check-in it was — "Olive Organiser's check-in has since come through". Null when it was the
    /// reader's own ("Your check-in…") or the record names nobody ("The court's check-in…").
    /// </summary>
    public string? ScannerName { get; init; }

    /// <summary>R15 J15-5: the reader's own check-in made the session attended.</summary>
    public bool ScannedByReader { get; init; }

    /// <summary>R16 J16-2: with <see cref="ShareActs.PlayerAdded"/>, who joined the game.</summary>
    public string? Joined { get; init; }

    /// <summary>R16 J16-2: who joined, or a neutral phrase when the record names nobody.</summary>
    public string JoinedName => string.IsNullOrWhiteSpace(Joined) ? "Another player" : Joined.Trim();
}

/// <summary>The organiser's acts (and a cancellation) a share mail words for itself — the wire's <c>share_cause</c> values (R14).</summary>
public static class ShareActs
{
    public const string OrganiserRemoved = "organiser_removed";
    public const string SplitChanged = "split_changed";
    public const string BookingCancelled = "booking_cancelled";
    public const string ClubSettled = "club_settled";

    /// <summary>R16 J16-2: a player joined an equal (or ratio) split, so this partner's share went down and the difference came back.</summary>
    public const string PlayerAdded = "player_added";
}

/// <summary>Why the club refunded a split session, so a returned share can say so (E10-7).</summary>
public static class ShareRefundCauses
{
    /// <summary>The sweep refunded it in full: the court's box was offline.</summary>
    public const string Outage = "outage";

    /// <summary>The sweep settled it as a no-show: nobody checked in.</summary>
    public const string NoShow = "no_show";

    /// <summary>It was displaced: the court was already in use by an earlier booking.</summary>
    public const string Displaced = "displaced";

    /// <summary>The cause in words, after "because"; null for a value this build does not know.</summary>
    public static string? Because(string? cause)
    {
        return cause switch
        {
            Outage => "the court's box was offline",
            NoShow => "nobody checked in",
            Displaced => "the court was already in use by an earlier booking",
            _ => null,
        };
    }
}

/// <summary>
/// The club put the reader on a game (an admin's add) or accepted one for them — review round 1,
/// B8: neither was told to the member at all. <paramref name="Accepted"/>: they are in, and nothing
/// is taken for their share until they accept it themselves (an admin's acceptance records no consent).
/// </summary>
public sealed record ClubSeatNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, bool Accepted, string Url);

/// <summary>A share still waiting — a reminder from the club, or a nudge from the organiser.</summary>
public sealed record ShareReminderNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, string DeadlineLocal,
    bool FromOrganiser, string AcceptUrl);

/// <summary>A share whose deadline passed. <see cref="ToOrganiser"/> decides who is reading.</summary>
public sealed record ShareLapsedNotice(
    string OtherName, string CourtName, string StartsAtLocal, int UnpaidMinutes, bool ToOrganiser, string BookingUrl);

/// <summary>A paid share on its way back to a partner, waiting until the organiser's minutes cover it.</summary>
public sealed record ShareReturnWaitingNotice(
    string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes, bool ToOrganiser, string BookingUrl);

/// <summary>
/// Who cancelled a game, for the partner's mail (review round 13, E13-6): the club (with the desk's
/// <paramref name="Reason"/>, or the system's <paramref name="Cause"/> — one of <see cref="ShareRefundCauses"/>)
/// or the organiser.
/// </summary>
public sealed record GameCancelledBy(bool ByClub, string? Reason, string? Cause);

/// <summary>A game that is off, as the cancellation mail names it. R15 E15-1: <paramref name="SessionStarted"/> — nothing was refunded.</summary>
public sealed record CancelledGame(string OrganiserName, string CourtName, string StartsAtLocal, bool SessionStarted = false)
{
    /// <summary>R16 J16-6: the reader paid the organiser by hand (the club recorded it) — nothing moves in the app either way.</summary>
    public bool SettledOutside { get; init; }
}

/// <summary>A change to a game the reader is in — they were taken off it, or their share moved.</summary>
public sealed record PlayersChange(
    string OrganiserName, string CourtName, string StartsAtLocal, bool Removed, int? NewShareMinutes, bool NeedsConsent,
    string BookingUrl)
{
    /// <summary>The club, not the organiser, took the reader off (review round 2, B-8).</summary>
    public bool ByClub { get; init; }

    /// <summary>
    /// R15 J15-9: the club recorded the reader's share as paid outside the app, so a new figure moves
    /// nothing in the app — "Your share now: 20 minutes" alone read as minutes about to be taken.
    /// </summary>
    public bool SettledOutside { get; init; }

    /// <summary>R16 J16-6: the mail is the club's record that the reader paid the organiser by hand.</summary>
    public bool SettledByHand { get; init; }
}

/// <summary>
/// The messages a game with more than one player sends (D11): the invite, the receipt for every
/// share that moves, the reminder, the lapse, a cancellation and a change.
/// </summary>
/// <remarks>
/// <para>
/// A partial of <see cref="EmailTemplates"/> for the length reason the admin-role partial gives.
/// Every figure is MINUTES — a share is a slice of a booking's minutes, and a minutes figure
/// never wears a money sign.
/// </para>
/// <para>
/// <b>No mail here ever says the reader owes anything.</b> A partner who does not pay is not in
/// debt: after the deadline the organiser's cover stands and the matter is closed. The wording is
/// held to that, because Playtomic's worst habit is a ledger of debts between friends.
/// </para>
/// </remarks>
public static partial class EmailTemplates
{
    private const string WhyGame =
        "You're getting this because a member of the club added you to a court booking.";

    /// <summary>A member has been asked to play, with their share and a link that opens the invite.</summary>
    public static EmailMessage PlayerInvite(ClubIdentity club, string to, PlayerInviteNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"{n.OrganiserName} invited you to play — {n.CourtName}",
            Preheader: n.ShareMinutes > 0
                ? $"{n.StartsAtLocal}. Your share would be {Min(n.ShareMinutes)}."
                : $"{n.StartsAtLocal}. {n.OrganiserName} is covering the court.",
            Heading: "You've been invited to a game",
            Blocks:
            [
                new Paragraph($"{n.OrganiserName} has booked {n.CourtName} at {club.Name} and would like you to play."),
                new Facts(
                [
                    new FactRow("Court", n.CourtName),
                    new FactRow("When", n.StartsAtLocal),
                    new FactRow("Your share", n.ShareMinutes > 0 ? Min(n.ShareMinutes) : "Nothing — covered"),
                ]),
                new CallToAction("See the invite", n.AcceptUrl),
                new Footnote("Nothing is taken until you accept. If you would rather not play, decline and the seat goes back to the organiser."),
            ],
            WhyThis: WhyGame));

    /// <summary>The receipt for a share moving, on whichever side of it the reader is.</summary>
    public static EmailMessage ShareMoved(ClubIdentity club, string to, ShareMovement m) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: ShareSubject(m),
            Preheader: $"{m.CourtName}, {m.StartsAtLocal}.",
            Heading: ShareHeading(m),
            Blocks: ShareBlocks(m),
            WhyThis: WhyMoney));

    private static List<EmailBlock> ShareBlocks(ShareMovement m)
    {
        var facts = new List<FactRow>
        {
            new("Court", m.CourtName),
            new("When", m.StartsAtLocal),
            new(m.Direction is ShareDirection.Paid or ShareDirection.Returned ? "Taken from your balance" : "Added to your balance", Min(m.AmountMinutes)),
        };
        if (m.HeldUntilLocal is { } held) facts.Add(new("Held until", held));
        var blocks = new List<EmailBlock> { new Paragraph(ShareSentence(m)) };
        if (m.ClubReason is { Length: > 0 } reason) blocks.Add(new Callout(CalloutTone.Info, $"Reason given by the club: {reason}"));
        blocks.Add(new Facts(facts));

        // B12: received shares are held to the deadline in case one has to go back (D11) — say so,
        // or "added to your balance" reads as money to spend tonight.
        if (m.HeldUntilLocal is { } until)
        {
            blocks.Add(new Callout(CalloutTone.Info,
                $"It is held until {until} in case a share has to go back to a player, and you can spend it after that."));
        }

        // B8: a club collect may take a partner below zero, by name — tell them where they stand.
        if (m.ByClub && m.BalanceAfterMinutes is { } after && after < 0)
        {
            blocks.Add(new Callout(CalloutTone.Warning,
                $"Your balance is now {Min(after)}, below zero. Buy minutes before you book again."));
        }
        blocks.Add(new CallToAction("Open the booking", m.BookingUrl));
        blocks.Add(new Footnote("Shares move between players only. The club's price for the court is unchanged."));
        return blocks;
    }

    /// <summary>The club added the reader to a game, or accepted one for them (B8).</summary>
    public static EmailMessage ClubSeat(ClubIdentity club, string to, ClubSeatNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.Accepted ? $"The club put you in {n.OrganiserName}'s game — {n.CourtName}" : $"The club added you to {n.OrganiserName}'s game — {n.CourtName}",
            Preheader: $"{n.StartsAtLocal}.",
            Heading: n.Accepted ? "You're in a game" : "You've been added to a game",
            Blocks: ClubSeatBlocks(n),
            WhyThis: WhyGame));

    private static List<EmailBlock> ClubSeatBlocks(ClubSeatNotice n)
    {
        var blocks = new List<EmailBlock>
        {
            new Paragraph(n.Accepted
                ? $"The club has put you in the game {n.OrganiserName} booked for {CourtOn(n.CourtName, n.StartsAtLocal)}."
                : $"The club has added you to the game {n.OrganiserName} booked for {CourtOn(n.CourtName, n.StartsAtLocal)}, and it is waiting for your answer."),
            new Facts(
            [
                new FactRow("Court", n.CourtName),
                new FactRow("When", n.StartsAtLocal),
                new FactRow("Your share", n.ShareMinutes > 0 ? Min(n.ShareMinutes) : "Nothing — covered"),
            ]),
        };
        if (n.ShareMinutes > 0)
        {
            blocks.Add(new Callout(CalloutTone.Info, n.Accepted
                // R13 J13-7: "until you accept it yourself" was broken by the desk's Collect, which takes it.
                ? "Your share is not taken automatically: it moves when you accept it in the app, or if the club collects it — you get a receipt either way."
                : "Nothing is taken until you accept. If you would rather not play, decline and the seat goes back to the organiser."));
        }
        blocks.Add(new CallToAction(n.Accepted ? "Open the booking" : "See the invite", n.Url));
        return blocks;
    }

    /// <summary>A share still waiting: the club's reminder, or the organiser's nudge.</summary>
    public static EmailMessage ShareReminder(ClubIdentity club, string to, ShareReminderNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.FromOrganiser ? $"{n.OrganiserName} is waiting for your answer — {n.CourtName}" : $"Your invite is still open — {n.CourtName}",
            Preheader: $"Your share is {Min(n.ShareMinutes)}. It can be paid until {n.DeadlineLocal}.",
            Heading: "Your share is still open",
            Blocks:
            [
                new Paragraph(n.FromOrganiser
                    ? $"{n.OrganiserName} would like to know if you are playing on {CourtOn(n.CourtName, n.StartsAtLocal)}."
                    : $"You have an open invite from {n.OrganiserName} for {CourtOn(n.CourtName, n.StartsAtLocal)}."),
                new Facts(
                [
                    new FactRow("Your share", Min(n.ShareMinutes)),
                    new FactRow("Open until", n.DeadlineLocal),
                ]),
                new CallToAction("Answer the invite", n.AcceptUrl),
                new Footnote("If you do nothing, the invite simply closes and the organiser covers the seat. You will not owe anything."),
            ],
            WhyThis: WhyGame));

    /// <summary>A share whose deadline passed with part of it unpaid.</summary>
    public static EmailMessage ShareLapsed(ClubIdentity club, string to, ShareLapsedNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.ToOrganiser ? $"{n.OtherName}'s share has closed — {n.CourtName}" : $"Your invite has closed — {n.CourtName}",
            Preheader: n.ToOrganiser ? "Your booking covers the seat, as it did from the start." : "Nothing is owed.",
            Heading: "A share has closed",
            Blocks:
            [
                new Paragraph(n.ToOrganiser
                    ? $"{n.OtherName} did not pay {Min(n.UnpaidMinutes)} of their share for {CourtOn(n.CourtName, n.StartsAtLocal)} before it closed. Your booking already covered the court, so nothing else moves."
                    : $"Your share for {CourtOn(n.CourtName, n.StartsAtLocal)} closed before it was paid. {n.OtherName}'s booking covers it and nothing is owed."),
                new CallToAction("Open the booking", n.BookingUrl),
            ],
            WhyThis: WhyGame));

    /// <summary>
    /// A return of a paid share is waiting: the organiser's minutes do not cover it yet. Told once
    /// to each side. It moves on its own the moment they do — buying a package is enough — and the
    /// wording says so, and no more: nobody here is in anybody's debt.
    /// </summary>
    public static EmailMessage ShareReturnWaiting(ClubIdentity club, string to, ShareReturnWaitingNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.ToOrganiser
                ? $"{Min(n.AmountMinutes)} for {n.OtherName} {Is(n.AmountMinutes)} waiting — {n.CourtName}"
                : $"{Min(n.AmountMinutes)} {Is(n.AmountMinutes)} on {(Is(n.AmountMinutes) == "is" ? "its" : "their")} way back — {n.CourtName}",
            Preheader: n.ToOrganiser ? "It goes back as soon as your balance covers it." : "It reaches you as soon as it can be sent.",
            Heading: "A share is on its way back",
            Blocks:
            [
                new Paragraph(n.ToOrganiser
                    ? $"{Min(n.AmountMinutes)} of {n.OtherName}'s share for {CourtOn(n.CourtName, n.StartsAtLocal)} {Is(n.AmountMinutes)} due back to them. Your balance doesn't cover it right now, so it will go back automatically the next time it does."
                    : $"{Min(n.AmountMinutes)} of your share for {CourtOn(n.CourtName, n.StartsAtLocal)} {Is(n.AmountMinutes)} due back to you from {n.OtherName}. It will reach your balance automatically as soon as it can be sent."),
                new CallToAction("Open the booking", n.BookingUrl),
            ],
            WhyThis: WhyGame));

    /// <summary>
    /// A game the reader was in has been cancelled — and, since review round 13 (E13-6), by whom and
    /// why: a partner was never told the CLUB had cancelled it, nor the reason the desk recorded.
    /// <paramref name="by"/> null keeps the plain words (a cancellation nobody recorded).
    /// </summary>
    public static EmailMessage PlayersBookingCancelled(
        ClubIdentity club, string to, string organiserName, string courtName, string startsAtLocal, GameCancelledBy? by = null) =>
        PlayersBookingCancelled(club, to, new CancelledGame(organiserName, courtName, startsAtLocal), by);

    /// <summary>
    /// <see cref="PlayersBookingCancelled(ClubIdentity, string, string, string, string, GameCancelledBy?)"/>,
    /// and R15 E15-1: when <see cref="CancelledGame.SessionStarted"/> — somebody had checked in, so the
    /// club refunded nothing and every share paid STANDS — it says so; "comes back … separate receipt"
    /// promised a refund that never came.
    /// </summary>
    public static EmailMessage PlayersBookingCancelled(ClubIdentity club, string to, CancelledGame game, GameCancelledBy? by = null) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Game cancelled — {game.CourtName}",
            Preheader: $"{game.StartsAtLocal}. {CancelledPreheader(game)}",
            Heading: by?.ByClub == true ? "The club cancelled this game" : "This game has been cancelled",
            Blocks: CancelledBlocks(game, by),
            WhyThis: WhyGame));

    /// <summary>What the preheader says of the reader's share — R16 J16-6: a share paid by hand is between them and the organiser.</summary>
    private static string CancelledPreheader(CancelledGame game)
    {
        if (game.SettledOutside) return ByHand(game.OrganiserName);
        return game.SessionStarted ? ShareStands : "Any share you paid comes back to you.";
    }

    /// <summary>R16 J16-6: the share the club recorded as paid to the organiser by hand.</summary>
    private static string ByHand(string organiser) =>
        $"You paid {organiser} by hand for this game, so any money back is between you and {organiser} — nothing moves in the app.";

    /// <summary>R15 E15-1: what a partner of a started session that was cancelled is told of their share.</summary>
    private const string ShareStands = "The session had started, so any share you paid stands.";

    private static List<EmailBlock> CancelledBlocks(CancelledGame game, GameCancelledBy? by)
    {
        var blocks = new List<EmailBlock> { new Paragraph(CancelledSentence(game.OrganiserName, CourtOn(game.CourtName, game.StartsAtLocal), by)) };
        if (by?.ByClub == true && ShareRefundCauses.Because(by.Cause) is { } because)
        {
            blocks.Add(new Callout(CalloutTone.Info, $"Why: {because}."));
        }
        else if (by?.ByClub == true && by.Reason is { Length: > 0 } reason)
        {
            blocks.Add(new Callout(CalloutTone.Info, $"Reason given by the club: {reason}"));
        }
        blocks.Add(new Callout(CalloutTone.Info, CancelledShareWords(game)));
        return blocks;
    }

    /// <summary>What the callout says of the reader's share: paid by hand (R16 J16-6), stands (R15 E15-1), or comes back.</summary>
    private static string CancelledShareWords(CancelledGame game)
    {
        if (game.SettledOutside) return ByHand(game.OrganiserName);
        return game.SessionStarted
            ? $"{ShareStands} The club refunded nothing for the court, so nothing moves back to your balance."
            : "If you had paid a share, it comes back to your balance — you will get a separate receipt for it.";
    }

    /// <param name="where">The court and its start, already said (<see cref="CourtOn"/>).</param>
    private static string CancelledSentence(string organiserName, string where, GameCancelledBy? by)
    {
        if (by is null) return $"The booking {organiserName} made for {where} has been cancelled.";
        return by.ByClub
            ? $"The club has cancelled the booking {organiserName} made for {where}."
            : $"{organiserName} has cancelled the booking for {where}.";
    }

    /// <summary>The reader was taken off a game, or their share of it changed.</summary>
    public static EmailMessage PlayersChanged(ClubIdentity club, string to, PlayersChange c) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: ChangeSubject(c),
            Preheader: c.StartsAtLocal,
            Heading: ChangeHeading(c),
            Blocks: ChangeBlocks(c),
            WhyThis: WhyGame));

    private static List<EmailBlock> ChangeBlocks(PlayersChange c)
    {
        var blocks = new List<EmailBlock>
        {
            new Paragraph(ChangeSentence(c)),
        };
        if (!c.Removed && c.NewShareMinutes is { } share) blocks.Add(new Facts([new FactRow(SettledNow(c) ? "Your share" : "Your share now", Min(share))]));
        if (SettledNow(c))
        {
            // R16 J16-6: the record itself — what was paid by hand is between the two players.
            blocks.Add(new Callout(CalloutTone.Info, $"Nothing is taken from or returned to your balance in the app for this share — you settled it with {c.OrganiserName} directly."));
        }
        else if (!c.Removed && c.SettledOutside)
        {
            // R15 J15-9: the club settled this share by hand; a new figure moves nothing in the app.
            blocks.Add(new Callout(CalloutTone.Info,
                "The club has recorded your share as paid outside the app, so nothing is taken or returned in the app for this change."));
        }
        else if (c.NeedsConsent)
        {
            blocks.Add(new Callout(CalloutTone.Warning, "Your share went up. Nothing more is taken until you accept the new figure."));
        }
        blocks.Add(new CallToAction("Open the booking", c.BookingUrl));
        return blocks;
    }

    /// <summary>R16 J16-6: the club recording a share as paid by hand is its own news, not "your share has changed".</summary>
    private static bool SettledNow(PlayersChange c) => !c.Removed && c.SettledByHand;

    private static string ChangeSubject(PlayersChange c)
    {
        if (c.Removed) return $"You've been taken off a game — {c.CourtName}";
        return SettledNow(c) ? $"Your share is recorded as paid by hand — {c.CourtName}" : $"Your share has changed — {c.CourtName}";
    }

    private static string ChangeHeading(PlayersChange c)
    {
        if (c.Removed) return "You're no longer in this game";
        return SettledNow(c) ? "Paid by hand" : "Your share has changed";
    }

    private static string ChangeSentence(PlayersChange c)
    {
        var where = CourtOn(c.CourtName, c.StartsAtLocal);
        if (SettledNow(c))
        {
            return $"The club has recorded that you paid {c.OrganiserName} by hand for {where}.";
        }
        if (c.Removed && c.ByClub)
        {
            return $"The club has taken you off the booking {c.OrganiserName} made for {where}. Any share you paid comes back to you.";
        }
        return c.Removed
            ? $"{c.OrganiserName} has taken you off the booking for {where}. Any share you paid comes back to you."
            : $"{c.OrganiserName} has changed how {where} is split.";
    }

    private static string ShareSubject(ShareMovement m)
    {
        if (m.AfterAttendance && m.Direction == ShareDirection.Paid) return $"Share taken again — {m.CourtName}";
        if (m.AfterAttendance && m.Direction == ShareDirection.Received) return $"{m.OtherName}'s share came back to you — {m.CourtName}";
        if (RefundSubject(m) is { } refund) return refund;
        if (ClubSubject(m) is { } club) return club;
        if (CauseSubject(m) is { } why) return why;
        switch (m.Direction)
        {
            case ShareDirection.Paid: return $"Share paid — {m.CourtName}";
            case ShareDirection.Received: return $"{m.OtherName} paid their share — {m.CourtName}";
            case ShareDirection.Refunded: return $"Share refunded — {m.CourtName}";
            default: return $"Share returned to {m.OtherName} — {m.CourtName}";
        }
    }

    /// <summary>The club's own hand — a collect or a removal — titled as the club's on both sides; null otherwise.</summary>
    private static string? ClubSubject(ShareMovement m)
    {
        if (m.ByClub && m.Direction == ShareDirection.Paid) return $"The club collected your share — {m.CourtName}";
        // R16 E16-5: the organiser's subject said "Sam paid their share" over a body saying the club collected it.
        if (m.ByClub && m.Direction == ShareDirection.Received) return $"The club collected {m.OtherName}'s share — {m.CourtName}";
        if (m.ClubRemoved && m.Direction == ShareDirection.Refunded) return $"The club took you off the game — {m.CourtName}";
        return m.ClubRemoved ? $"The club took {m.OtherName} off your game — {m.CourtName}" : null;
    }

    /// <summary>R14 X14-2 / J14-8: the partner's subject for an organiser's act or a cancellation; null otherwise.</summary>
    private static string? ActSubject(ShareMovement m)
    {
        if (m.Direction != ShareDirection.Refunded) return null;
        return m.Cause switch
        {
            ShareActs.OrganiserRemoved => $"{m.OtherName} took you off the game — {m.CourtName}",
            ShareActs.SplitChanged => $"Your share was lowered — {m.CourtName}",
            ShareActs.PlayerAdded => $"Your share went down: {m.JoinedName} joined — {m.CourtName}",
            ShareActs.ClubSettled => $"Your share is settled outside the app — {m.CourtName}",
            ShareActs.BookingCancelled when m.CancelledBy == "club" => $"The club cancelled the game — {m.CourtName}",
            ShareActs.BookingCancelled when m.CancelledBy == "member" => $"{m.OtherName} cancelled the game — {m.CourtName}",
            _ => null,
        };
    }

    /// <summary>A subject that says why the share moved — a withdrawal, an organiser's act, a cancellation (R14 / R15 E15-8); null otherwise.</summary>
    private static string? CauseSubject(ShareMovement m) => WithdrewSubject(m) ?? ActSubject(m) ?? ReturnedSubject(m);

    /// <summary>R15 E15-8: a withdrawal titled as one on both sides — the partner's read "Share refunded".</summary>
    private static string? WithdrewSubject(ShareMovement m)
    {
        if (!m.Withdrew) return null;
        return m.Direction switch
        {
            ShareDirection.Refunded => $"Your share came back: you withdrew — {m.CourtName}",
            ShareDirection.Returned => $"Share returned to {m.OtherName}: they withdrew — {m.CourtName}",
            _ => null,
        };
    }

    /// <summary>
    /// R15 E15-8: the organiser's side of an act that sent a share back, with its cause — "Share
    /// returned to Sam" alone gave them none. Null for any other movement.
    /// </summary>
    private static string? ReturnedSubject(ShareMovement m)
    {
        if (m.Direction != ShareDirection.Returned) return null;
        var why = m.Cause switch
        {
            ShareActs.OrganiserRemoved => "you took them off the game",
            ShareActs.SplitChanged => "you lowered their share",
            ShareActs.PlayerAdded => $"{m.JoinedName} joined",
            ShareActs.ClubSettled => "the club settled it outside the app",
            ShareActs.BookingCancelled when m.CancelledBy == "club" => "the club cancelled the game",
            ShareActs.BookingCancelled when m.CancelledBy == "member" => "you cancelled the game",
            _ => null,
        };
        return why is null ? null : $"Share returned to {m.OtherName}: {why} — {m.CourtName}";
    }

    /// <summary>A club refund's subject (E10-7), or a no-show's that kept part of the share (E11-2); null otherwise.</summary>
    private static string? RefundSubject(ShareMovement m)
    {
        var mine = m.Direction == ShareDirection.Refunded;
        if (m.KeptForNoShow)
        {
            return mine
                ? $"No-show: part of your share came back — {m.CourtName}"
                : $"No-show: part of {m.OtherName}'s share went back — {m.CourtName}";
        }
        if (ShareRefundCauses.Because(m.ClubRefund) is null) return null;
        return mine
            ? $"The club refunded your share — {m.CourtName}"
            : $"The club refunded {m.OtherName}'s share — {m.CourtName}";
    }

    private static string ShareHeading(ShareMovement m)
    {
        if (m.AfterAttendance && m.Direction == ShareDirection.Paid) return "Your share was taken again";
        if (m.ByClub && m.Direction == ShareDirection.Paid) return "The club collected your share";
        if (m.ByClub && m.Direction == ShareDirection.Received) return $"The club collected {m.OtherName}'s share";
        if (m.ClubRemoved) return "Taken off by the club";
        switch (m.Direction)
        {
            case ShareDirection.Paid: return "You paid your share";
            case ShareDirection.Received: return "A share has come in";
            case ShareDirection.Refunded: return "Your share came back";
            default: return "A share went back";
        }
    }

    private static string ShareSentence(ShareMovement m)
    {
        if (m.ByClub) return ClubShareSentence(m);
        if (m.AfterAttendance) return AttendedSentence(m);
        if (m.ClubRemoved) return ClubRemovedSentence(m);
        if (m.KeptForNoShow) return NoShowSentence(m);
        if (ShareRefundCauses.Because(m.ClubRefund) is { } because) return ClubRefundSentence(m, because);
        if (m.Withdrew) return WithdrewSentence(m);
        if (ActSentence(m) is { } act) return act;
        switch (m.Direction)
        {
            case ShareDirection.Paid: return $"You paid {Min(m.AmountMinutes)} to {m.OtherName} for your share of the court.";
            case ShareDirection.Received: return $"{m.OtherName} paid you {Min(m.AmountMinutes)} for their share of your booking.";
            case ShareDirection.Refunded: return $"{Min(m.AmountMinutes)} of your share came back from {m.OtherName}.";
            default: return $"{Min(m.AmountMinutes)} of {m.OtherName}'s share went back to them from your balance.";
        }
    }

    /// <summary>
    /// Review round 2, B-8: the club REMOVED the partner, and their share went back. "X of your share
    /// came back from Sam" told the partner the organiser had done it; the club did.
    /// </summary>
    private static string ClubRemovedSentence(ShareMovement m)
    {
        return m.Direction == ShareDirection.Refunded
            ? $"The club took you off the game {m.OtherName} booked, and {Min(m.AmountMinutes)} of your share came back to your balance."
            : $"The club took {m.OtherName} off your game, and {Min(m.AmountMinutes)} of their share went back to them from your balance.";
    }

    /// <summary>
    /// R14 X14-2 / J14-8: the organiser took the partner off, lowered their share, or the game was
    /// cancelled — and the share followed. "Share refunded" with no cause left them guessing.
    /// </summary>
    private static string? ActSentence(ShareMovement m)
    {
        var mine = m.Direction == ShareDirection.Refunded;
        var back = mine
            ? $"{Min(m.AmountMinutes)} of your share came back to your balance"
            : $"{Min(m.AmountMinutes)} of {m.OtherName}'s share went back to them from your balance";
        var why = m.Cause switch
        {
            ShareActs.OrganiserRemoved => mine ? $"{m.OtherName} took you off the game" : $"You took {m.OtherName} off the game",
            ShareActs.SplitChanged => mine ? $"{m.OtherName} lowered your share of the court" : $"You lowered {m.OtherName}'s share of the court",
            ShareActs.PlayerAdded => $"{m.JoinedName} joined the game and the split went down",
            ShareActs.ClubSettled => mine ? "The club recorded your share as paid outside the app" : $"The club recorded {m.OtherName}'s share as paid outside the app",
            ShareActs.BookingCancelled => CancelledWhy(m, mine),
            _ => null,
        };
        return why is null ? null : $"{why}, so {back}.";
    }

    /// <summary>R14 J14-8: who cancelled, at the start of the share mail's sentence; null when unrecorded.</summary>
    private static string? CancelledWhy(ShareMovement m, bool mine)
    {
        return m.CancelledBy switch
        {
            "club" => mine ? $"The club cancelled the game {m.OtherName} booked" : "The club cancelled your booking",
            "member" => mine ? $"{m.OtherName} cancelled the game" : "You cancelled the booking",
            _ => null,
        };
    }

    /// <summary>R13 E13-4: the partner pulled out, and their share went back — the organiser was given no cause.</summary>
    private static string WithdrewSentence(ShareMovement m)
    {
        return m.Direction == ShareDirection.Refunded
            ? $"You withdrew from the game {m.OtherName} booked, so {Min(m.AmountMinutes)} of your share came back to your balance."
            : $"{m.OtherName} withdrew from the game, so {Min(m.AmountMinutes)} of their share went back to them from your balance.";
    }

    /// <summary>
    /// Review round 10, E10-7: the CLUB refunded the session (an outage, a no-show sweep, a
    /// displacement), and the share followed. "came back from Olive" told the partner the organiser
    /// had returned it.
    /// </summary>
    private static string ClubRefundSentence(ShareMovement m, string because)
    {
        return m.Direction == ShareDirection.Refunded
            ? $"The club refunded the session because {because}, so {Min(m.AmountMinutes)} of your share came back to your balance."
            : $"The club refunded the session because {because}, so {Min(m.AmountMinutes)} of {m.OtherName}'s share went back to them from your balance.";
    }

    /// <summary>
    /// Review round 11, E11-2: a no-show settlement keeps a penalty, and a split session's partner
    /// carries their part of it — the mail names that part and what came back.
    /// </summary>
    private static string NoShowSentence(ShareMovement m)
    {
        var kept = Min(m.KeptMinutes ?? 0);
        var paid = Min(m.AmountMinutes + (m.KeptMinutes ?? 0));
        return m.Direction == ShareDirection.Refunded
            ? $"Nobody checked in, so the club settled the session as a no-show: it refunded the court less its no-show penalty. Your part of that penalty is {kept}, so {Min(m.AmountMinutes)} of the {paid} you paid came back to your balance."
            : $"Nobody checked in, so the club settled the session as a no-show: it refunded the court less its no-show penalty. {m.OtherName}'s part of that penalty is {kept}, so {Min(m.AmountMinutes)} of the {paid} they paid went back to them from your balance.";
    }

    /// <summary>Review round 9, E9-2: the refund was reversed because the session was attended, so the share follows the court again.</summary>
    /// <remarks>R15 J15-5: names whose check-in it was; J15-11: the figure's verb agrees with it.</remarks>
    private static string AttendedSentence(ShareMovement m)
    {
        var checkIn = m.ScannedByReader ? "your check-in"
            : string.IsNullOrWhiteSpace(m.ScannerName) ? "the court's check-in" : $"{m.ScannerName.Trim()}'s check-in";
        return m.Direction == ShareDirection.Paid
            ? $"Your share came back to you when the club refunded the booking, but {checkIn} has since come through — the session was attended, so {Min(m.AmountMinutes)} {Was(m.AmountMinutes)} taken from your balance again and paid to {m.OtherName}."
            : $"{Capital(checkIn)} has since come through and the session was attended, so {m.OtherName}'s share of {Min(m.AmountMinutes)} was taken again and paid to you.";
    }

    private static string Capital(string text) => text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];

    /// <summary>B8: a share the CLUB collected — "You paid your share…" told the partner they had done something they had not.</summary>
    private static string ClubShareSentence(ShareMovement m)
    {
        return m.Direction == ShareDirection.Paid
            ? $"The club collected {Min(m.AmountMinutes)} from your balance for your share of the court {m.OtherName} booked."
            : $"The club collected {Min(m.AmountMinutes)} from {m.OtherName} for their share of your booking.";
    }
}
