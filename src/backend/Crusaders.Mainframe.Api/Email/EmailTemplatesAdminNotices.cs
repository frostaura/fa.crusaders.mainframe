namespace Crusaders.Mainframe.Api.Email;

/// <summary>Applications that have waited past the club's reminder threshold.</summary>
public sealed record ApplicationsWaiting(int Count, string OldestName, int OldestHours, string ConsoleUrl);

/// <summary>Several different faults open across the club's boards at once.</summary>
public sealed record FaultSpike(int Faults, int Minutes, IReadOnlyList<string> Boards, string ConsoleUrl);

/// <summary>One door turning a lot of scans away inside the club's own window.</summary>
public sealed record DoorRefusalSpike(string DoorName, string DeviceCode, string? GateKey, int Refusals, int Minutes, string ConsoleUrl);

/// <summary>
/// A package purchase that went wrong in a way an admin can act on (admin-notice kind
/// <c>topup.failed</c>, whose code is kept — contract §12.2). <see cref="AmountZar"/> is money —
/// what the member was asked for — and carries the club's symbol; <see cref="Minutes"/> is the
/// package's minutes and never does. Both package fields are null on a notice raised before P13,
/// or for a notification that names no purchase.
/// </summary>
public sealed record TopUpFailure(
    string Reason, decimal? AmountZar, string? MemberName, string? Reference, string Symbol, string ConsoleUrl,
    string? PackageName = null, int? Minutes = null);

/// <summary>A club webhook the delivery worker has switched off.</summary>
public sealed record WebhookDisabled(string Destination, string? Description, int Failures, bool Blocked, string ConsoleUrl);

/// <summary>A repeating booking with nights it could not place.</summary>
public sealed record ScheduleConflictNotice(string ScheduleName, string FirstDate, int Collisions, IReadOnlyList<string> Dates, string ConsoleUrl);

/// <summary>An admin's booking that took a balance below zero. Every figure is minutes.</summary>
public sealed record OverdraftNotice(
    string ActorName, string MemberName, bool Self, string CourtName, string StartsAtLocal,
    int AmountMinutes, int BalanceAfterMinutes, string ConsoleUrl)
{
    /// <summary>Minutes held for partners' shares; null on a notice queued before it was carried.</summary>
    public int? HeldMinutes { get; init; }
}

/// <summary>A code a board accepted that the server could not have issued. Placeholder for P7.</summary>
public sealed record ForgeryNotice(string DeviceCode, string? MemberName, string Detail, string ConsoleUrl);

/// <summary>A board that reported firmware without the member-code capability after the club's cut-over.</summary>
public sealed record BoardLostMemberCodes(string DeviceName, string DeviceCode, string? FirmwareVersion, string ConsoleUrl);

/// <summary>
/// The admin-attention messages R23 added: everything the notifier sends that no path in the
/// product sent before it. The messages it MOVED onto the outbox — the registration notice, the
/// outage pairs, the admin-rights notices — keep their own templates and their own wording.
/// </summary>
/// <remarks>
/// A partial of <see cref="EmailTemplates"/> for the reason <c>EmailTemplatesAdminRole.cs</c> is
/// one: that file is near a thousand lines of raw-string-dense members. The house rules are
/// unchanged — blocks, never markup, the club first, and every message says why the reader has it.
/// </remarks>
public static partial class EmailTemplates
{
    /// <summary>Whole hours in words — "1 hour", "26 hours" (R9: "1 hours" read wrong).</summary>
    private static string HoursSpoken(int n) => n == 1 ? "1 hour" : $"{n} hours";

    /// <summary>A daily nudge while applications wait. Names the oldest, because that is the one somebody is waiting on.</summary>
    public static EmailMessage AdminApplicationsWaiting(ClubIdentity club, string to, ApplicationsWaiting w) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: w.Count == 1 ? "1 application is still waiting" : $"{w.Count} applications are still waiting",
            Preheader: $"The oldest, {w.OldestName}, has waited {HoursSpoken(w.OldestHours)}. Nobody can book until they're approved.",
            Heading: "Applications are waiting for approval",
            Blocks:
            [
                new Paragraph($"{Plural(w.Count, "application is", "applications are")} waiting for an administrator at {club.Name}."),
                new Facts(
                [
                    new FactRow("Waiting", w.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                    new FactRow("Oldest", w.OldestName),
                    new FactRow("Waiting for", $"{HoursSpoken(w.OldestHours)}"),
                ]),
                new Paragraph("Each applicant was told this takes a day or two. You'll get this reminder at most once a day while any application is waiting."),
                new CallToAction("Review the applications", w.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>Several faults at once — the pattern a single fault row cannot show.</summary>
    public static EmailMessage AdminFaultSpike(ClubIdentity club, string to, FaultSpike f) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"{f.Faults} device faults in {Min(f.Minutes)}",
            Preheader: "Several different faults opened across the club's boards at once.",
            Heading: "The club's boards are reporting several faults",
            Blocks:
            [
                new Paragraph($"{f.Faults} different faults have been reported at {club.Name} in the last {Min(f.Minutes)}. One fault on its own is on the Faults page; several at once usually share a cause — the network, the power, or a firmware change."),
                new Facts(
                [
                    new FactRow("Faults", f.Faults.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                    new FactRow("Boards", f.Boards.Count == 0 ? "Not identified" : string.Join(", ", f.Boards)),
                ]),
                new CallToAction("Open the Faults page", f.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>
    /// A door turning many scans away. Names the door and the count, never a person: a door flag
    /// that named members would be a per-member observation in an inbox.
    /// </summary>
    public static EmailMessage AdminDoorRefusalSpike(ClubIdentity club, string to, DoorRefusalSpike r) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"{r.DoorName} is turning people away",
            Preheader: $"{r.Refusals} refused scans in {Min(r.Minutes)}.",
            Heading: "A door is refusing a lot of scans",
            Blocks:
            [
                new Paragraph($"{r.DoorName} at {club.Name} refused {r.Refusals} scans in the last {Min(r.Minutes)}."),
                new Facts(
                [
                    new FactRow("Door", Door(r.GateKey)),
                    new FactRow("Board", r.DeviceCode),
                    new FactRow("Refused", $"{r.Refusals} in {Min(r.Minutes)}"),
                ]),
                new Paragraph("It is usually one of three things: members without a booking trying the door, a board working from a stale list, or a code that has stopped matching. The door's own page shows which."),
                new CallToAction("Open the Doors page", r.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>A package purchase that failed for a reason the club, not the member, has to look at.</summary>
    public static EmailMessage AdminTopUpFailed(ClubIdentity club, string to, TopUpFailure t)
    {
        var facts = new List<FactRow> { new("What happened", TopUpFailureReason(t.Reason)) };
        if (t.MemberName is not null) facts.Add(new FactRow("Member", t.MemberName));
        if (t.PackageName is not null) facts.Add(new FactRow("Package", t.Minutes is { } m ? $"{t.PackageName} ({Min(m)})" : t.PackageName));
        if (t.AmountZar is { } amount) facts.Add(new FactRow("Amount asked for", Zar(amount, t.Symbol)));
        if (t.Reference is not null) facts.Add(new FactRow("Reference", t.Reference));

        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: "A package purchase needs looking at",
            Preheader: TopUpFailureReason(t.Reason),
            Heading: "A package purchase did not go through",
            Blocks:
            [
                new Paragraph($"A card payment at {club.Name} did not become minutes, for a reason the member cannot fix themselves."),
                new Facts(facts),
                TopUpFailureOutcome(t.Reason),
                new CallToAction("Open Transactions", t.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));
    }

    /// <summary>
    /// A club webhook switched off — the mail <c>docs/specs/webhooks.md</c> promised the owner and
    /// nothing sent. The club's endpoints are owned by the club, so its administrators are the owner.
    /// </summary>
    public static EmailMessage AdminWebhookDisabled(ClubIdentity club, string to, WebhookDisabled w) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "A webhook has been switched off",
            Preheader: w.Blocked
                ? "Its destination is not allowed from this deployment."
                : $"It failed {w.Failures} times in a row.",
            Heading: "A webhook has stopped receiving events",
            Blocks:
            [
                new Paragraph(w.Blocked
                    ? $"A webhook at {club.Name} points somewhere this deployment is not allowed to send to, so it has been switched off."
                    : $"A webhook at {club.Name} failed {w.Failures} deliveries in a row, over about two days of retries, so it has been switched off."),
                new Facts(
                [
                    new FactRow("Destination", w.Destination),
                    new FactRow("Description", string.IsNullOrWhiteSpace(w.Description) ? "None given" : w.Description),
                ]),
                new Callout(CalloutTone.Warning, "Nothing is sent to it until somebody switches it back on. Events in between are not replayed."),
                new CallToAction("Open Webhooks", w.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>A repeating booking that could not take some of its nights, because somebody already holds them.</summary>
    public static EmailMessage AdminScheduleConflict(ClubIdentity club, string to, ScheduleConflictNotice c) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"{c.ScheduleName} could not be placed on {c.FirstDate}",
            Preheader: $"{c.Collisions} court-times are already booked. The schedule stops there until they're cleared.",
            Heading: "A repeating booking has a clash",
            Blocks:
            [
                new Paragraph($"{c.ScheduleName} at {club.Name} could not take {Plural(c.Collisions, "court-time", "court-times")}, because members already hold them. Nothing was overwritten."),
                new Facts(
                [
                    new FactRow("First clash", c.FirstDate),
                    new FactRow("Dates", string.Join(", ", c.Dates)),
                ]),
                new Paragraph("The schedule is not written past the first clash until it is cleared — cancel the members' bookings with a refund, or skip that date."),
                new CallToAction("Open Repeating bookings", c.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>
    /// An admin took a balance below zero. Every figure is minutes; the club's money symbol is
    /// deliberately absent.
    /// </summary>
    public static EmailMessage AdminOverdraftAuthorised(ClubIdentity club, string to, OverdraftNotice o) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: o.Self
                ? $"{o.ActorName} booked below zero"
                : $"{o.ActorName} took {o.MemberName} below zero",
            Preheader: $"{o.CourtName}, {o.StartsAtLocal}. {OverdraftHeadlineFigure(o)}.",
            Heading: "A booking took a balance below zero",
            Blocks:
            [
                new Paragraph(o.Self
                    ? $"{o.ActorName} booked a court at {club.Name} for themselves that their balance did not cover."
                    : $"{o.ActorName} booked a court at {club.Name} for {o.MemberName} that the member's balance did not cover."),
                new Facts(OverdraftFacts(o)),
                new Paragraph("Administrators may do this, and every time one does, every other administrator is told. The change record shows the balance and what could be spent, before and after."),
                new CallToAction("Open the change record", o.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>
    /// The figure the overdraft was decided on (review round 3, A-8): what the member may SPEND
    /// after the booking — the balance less the shares held for partners — which is exactly what
    /// the desk's confirm step showed ("takes to −1 h 20 min"). The raw balance said −30 minutes beside it,
    /// with a hyphen, and the two read as a contradiction. A notice queued before the held figure
    /// was carried keeps the old label, because its figure is the balance.
    /// </summary>
    private static string OverdraftHeadlineFigure(OverdraftNotice o)
    {
        return o.HeldMinutes is { } held
            ? $"Can spend after: {Min(o.BalanceAfterMinutes - held)}"
            : $"Balance after: {Min(o.BalanceAfterMinutes)}";
    }

    private static IReadOnlyList<FactRow> OverdraftFacts(OverdraftNotice o)
    {
        var rows = new List<FactRow>
        {
            new("Court", o.CourtName),
            new("When", o.StartsAtLocal),
            new("Charged", Min(o.AmountMinutes)),
        };
        if (o.HeldMinutes is not { } held)
        {
            rows.Add(new FactRow("Balance after", Min(o.BalanceAfterMinutes)));
            return rows;
        }

        rows.Add(new FactRow("Can spend after", Min(o.BalanceAfterMinutes - held)));
        // Only when they differ: a second figure that always equals the first is noise.
        if (held != 0)
        {
            rows.Add(new FactRow("Held for partners", Min(held)));
            rows.Add(new FactRow("Balance after", Min(o.BalanceAfterMinutes)));
        }
        return rows;
    }

    /// <summary>
    /// A board accepted a code the server could not have issued. The catalogue entry exists so the
    /// kind is non-optional from day one; P7 raises it.
    /// </summary>
    public static EmailMessage AdminCodeForgerySuspected(ClubIdentity club, string to, ForgeryNotice f) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"A forged code may have been used — {f.DeviceCode}",
            Preheader: "A board accepted a code this club never issued.",
            Heading: "A code may have been forged",
            Blocks:
            [
                new Paragraph($"A board at {club.Name} accepted a code that the club's system could not have issued."),
                new Facts(
                [
                    new FactRow("Board", f.DeviceCode),
                    new FactRow("Code claimed to be", f.MemberName ?? "Nobody the club knows"),
                    new FactRow("Detail", f.Detail),
                ]),
                new Callout(CalloutTone.Danger, "Treat the board as compromised until somebody has looked at it. Every administrator gets this message; nobody can opt out of it."),
                new CallToAction("Open the Devices page", f.ConsoleUrl),
            ],
            WhyThis: WhyAdmin), highPriority: true);

    /// <summary>
    /// A board went back to firmware that cannot check member codes offline — a spare flashed
    /// with an old image, usually. Online it still works; offline it now admits nobody on a code.
    /// </summary>
    public static EmailMessage AdminBoardLostMemberCodes(ClubIdentity club, string to, BoardLostMemberCodes b) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"A board stopped reading member codes — {b.DeviceCode}",
            Preheader: "It still works while it can reach the club's system; offline it can no longer check codes.",
            Heading: "A board is running firmware without member codes",
            Blocks:
            [
                new Paragraph($"{club.Name} has switched to members' rotating codes, and a board has just reported firmware that cannot check them on its own."),
                new Facts(
                [
                    new FactRow("Board", b.DeviceName),
                    new FactRow("Code", b.DeviceCode),
                    new FactRow("Firmware", b.FirmwareVersion ?? "Not reported"),
                ]),
                new Paragraph("While it can reach the club's system every code still works at it. If its connection drops, members will be refused there until it is reflashed with current firmware."),
                new CallToAction("Open the Devices page", b.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>
    /// What has and has not happened to the member's money, and whether anybody told them — per
    /// reason, because the paths differ. One sentence for all of them ("has been emailed that
    /// their purchase did not complete") was false on two: a gateway reporting a payment with no
    /// reference is a member who HAS PAID, whose purchase is still open and who has been told
    /// nothing; a checkout the gateway refused to start took no money and was shown on screen,
    /// not mailed. Block body for the lizard reason in <c>memory/gotchas-build.md</c>.
    /// </summary>
    private static EmailBlock TopUpFailureOutcome(string reason)
    {
        switch (reason)
        {
            case "payment_id_missing":
                return new Callout(CalloutTone.Warning,
                    "The gateway says this member paid, but no minutes were added and the member has not been told anything. "
                    + "The purchase is still open: if the gateway sends a complete notification the minutes are added then. "
                    + "If it does not, check the payment in the gateway's own dashboard before selling the member the package at the desk.");
            case "provider_register_failed":
                return new Paragraph(
                    "No payment was taken and no minutes were added. The member saw an error on the buy-minutes screen and was not emailed; "
                    + "nobody can buy minutes online until the club's payment settings are fixed.");
            case "signature_invalid":
                return new Paragraph(
                    "No minutes were added and nothing was changed: the notification was ignored. If the club's payment settings "
                    + "changed recently the passphrase may not match; otherwise somebody may be sending notifications that did not come from the gateway.");
            default:
                return new Paragraph("No minutes were added. The member has been emailed that their purchase did not complete.");
        }
    }

    /// <summary>Why a package purchase failed, in the words an admin reads. Block body for the lizard reason in <c>memory/gotchas-build.md</c>.</summary>
    private static string TopUpFailureReason(string reason)
    {
        switch (reason)
        {
            case "amount_mismatch": return "The gateway reported a different amount from the one the member was asked for.";
            case "gateway_error": return "The gateway reported an error it did not explain.";
            case "provider_register_failed": return "The gateway refused to start the payment — the club's payment settings may be wrong.";
            case "signature_invalid": return "A payment notification arrived that did not carry the club's signature.";
            case "payment_id_missing": return "The gateway reported a payment with no payment reference, so no minutes could be added safely.";
            default: return "The payment did not complete.";
        }
    }

    /// <summary>"1 thing is" / "3 things are". Invariant digits.</summary>
    private static string Plural(int count, string one, string many) =>
        $"{count.ToString(System.Globalization.CultureInfo.InvariantCulture)} {(count == 1 ? one : many)}";
}
