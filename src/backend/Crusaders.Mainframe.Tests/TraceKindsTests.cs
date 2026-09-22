using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The night trace's closed vocabulary, pinned against the actions the code actually writes.
///
/// <para>
/// <b>This is <c>DoorAuditActionsTests</c>'s argument applied one surface earlier.</b> A console
/// holding its own dictionary painted <c>device.updated</c> as a green "Refused" scan and a door
/// with thirteen admin edits read "13 refused scans". The trace composes its headline on the
/// server for that reason, and this file is what stops the dictionary and the writers drifting:
/// every audit action the five writing paths emit must be either a word in
/// <see cref="TraceKinds"/> or an explicitly declared exclusion, and never
/// <see cref="TraceKinds.Unrecognised"/> — because <c>unrecognised</c> is the answer for an
/// action nobody has met yet, not a place to put the ones we have.
/// </para>
/// </summary>
public sealed class TraceKindsTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "whitelizard.txt"))
                && Directory.Exists(Path.Combine(dir.FullName, "docs")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("The repository root was not found above the test binary.");
    }

    /// <summary>
    /// The files D2 §6.3 names as the writers of every row a member's night is assembled from.
    ///
    /// <para>
    /// Named rather than globbed: a glob over the whole tree would go red on a migration's
    /// column named <c>Action</c> and on a lane that has not landed yet, and a test that goes
    /// red for a reason it is not about is a test people start ignoring.
    /// </para>
    /// </summary>
    private static readonly string[] WriterFiles =
    [
        "Services/BookingService.cs",
        "Services/AdminBlockService.cs",
        "Services/CourtActivationService.cs",
        "Endpoints/DeviceGateEndpoint.cs",
    ];

    /// <summary>Every <c>Action = "…"</c> literal one of those files writes.</summary>
    private static List<string> WrittenActions()
    {
        var root = Path.Combine(RepoRoot(), "src", "backend", "Crusaders.Mainframe.Api");
        var found = new List<string>();
        foreach (var file in WriterFiles)
        {
            var text = File.ReadAllText(Path.Combine(root, file));
            foreach (Match m in Regex.Matches(text, """Action = "([a-z_.]+)"""))
            {
                found.Add(m.Groups[1].Value);
            }
        }
        return found;
    }

    /// <summary>
    /// Every action those files write has a word of its own, or is a declared exclusion.
    ///
    /// <para>
    /// The one answer this test refuses is <c>unrecognised</c>: it is the honest rendering for
    /// an action this vocabulary has never met, and using it for one we have met is how a
    /// dictionary rots while still looking complete.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_action_the_writers_emit_is_either_a_word_or_a_declared_exclusion()
    {
        var actions = WrittenActions();

        // The regex has to find something, or this test is green because it read nothing.
        Assert.True(actions.Count >= 10, $"Only {actions.Count} audit actions found — the scan is broken, not the code.");

        foreach (var action in actions.Distinct())
        {
            var kind = TraceKinds.OfAudit(action, actorIsSubject: true);
            Assert.True(
                kind is null || kind != TraceKinds.Unrecognised,
                $"'{action}' renders as '{TraceKinds.Unrecognised}'. Give it a word in TraceKinds, or " +
                "declare it in TraceKinds.NotAPersonsNight with the reason it is not on a member's night.");
        }
    }

    /// <summary>
    /// The four dynamic action shapes — a refusal reason appended, an uploaded kind appended,
    /// an outcome code appended — reach a word rather than falling off the end of the switch.
    /// </summary>
    [Theory]
    [InlineData("gate.denied_not_recognised", TraceKinds.DoorRefused)]
    [InlineData("gate.denied_no_booking", TraceKinds.DoorRefused)]
    [InlineData("gate.opened", TraceKinds.DoorOpened)]
    [InlineData("device.gate_open", TraceKinds.DoorOpenedOffline)]
    [InlineData("device.gate_open_not_a_court_box", TraceKinds.DoorRefused)]
    [InlineData("device.unknown_scan", TraceKinds.DoorRefused)]
    [InlineData("device.activation", TraceKinds.CourtCheckedIn)]
    [InlineData("device.activation_no_booking", TraceKinds.CourtRefused)]
    [InlineData("device.release", TraceKinds.LightsOff)]
    [InlineData("court.activated", TraceKinds.CourtCheckedIn)]
    [InlineData("court.lights_on", TraceKinds.LightsOn)]
    [InlineData("court.lights_off", TraceKinds.LightsOff)]
    [InlineData("court.activation_refused", TraceKinds.CourtRefused)]
    [InlineData("booking.created", TraceKinds.BookingMade)]
    [InlineData("booking.created_on_behalf", TraceKinds.BookingMadeForThem)]
    [InlineData("booking.created_on_behalf_overdrawn", TraceKinds.BookingMadeForThem)]
    [InlineData("booking.walk_up_created", TraceKinds.WalkUpBought)]
    [InlineData("booking.walk_up_voided", TraceKinds.WalkUpRefunded)]
    [InlineData("booking.blocked", TraceKinds.BookingBlockedOver)]
    [InlineData("booking.displaced", TraceKinds.BookingDisplaced)]
    [InlineData("booking.no_show_reversed", TraceKinds.BookingNoShowReversed)]
    public void One_action_reaches_one_word(string action, string expected)
        => Assert.Equal(expected, TraceKinds.OfAudit(action, actorIsSubject: true));

    /// <summary>
    /// An action that merely BEGINS like one of ours is not one of ours.
    ///
    /// <para>
    /// <b>Written after a surviving mutant.</b> Replacing the suffix-boundary check with a plain
    /// <c>StartsWith</c> left every test in this class green, and the shape it lets through is
    /// real: the upload path builds its action from a board-supplied <c>kind</c> that is
    /// lower-cased and truncated and otherwise unexamined, so a board emitting
    /// <c>releasex</c> writes <c>device.releasex</c>. Under the mutant that reads on a member's
    /// night as "the lights went off", which is a sentence about a court from a string nobody
    /// checked. <c>DoorTrail.IsScanRow</c> makes the identical argument about the refusal prefix
    /// and the <c>LIKE</c> wildcard — one place in this product has already paid for it.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("device.releasex")]
    [InlineData("device.activationz")]
    [InlineData("device.gate_opening")]
    [InlineData("device.unknown_scanning")]
    public void An_action_that_merely_starts_like_another_is_not_it(string action)
        => Assert.Null(TraceKinds.OfAudit(action, actorIsSubject: true));

    /// <summary>
    /// <b>Who cancelled is the question, and it is never "the actor is not the subject".</b>
    /// D2-B41: that predicate makes every automatic sweep claim an admin did it. The split here
    /// is on whether the person whose night this is did it themselves.
    /// </summary>
    [Fact]
    public void A_cancellation_says_whether_the_member_did_it()
    {
        Assert.Equal(TraceKinds.BookingCancelled, TraceKinds.OfAudit("booking.cancelled", actorIsSubject: true));
        Assert.Equal(TraceKinds.BookingCancelledByClub, TraceKinds.OfAudit("booking.cancelled", actorIsSubject: false));
    }

    /// <summary>
    /// The settlement's own bookkeeping is not a person's night, and it is declared rather than
    /// dropped by omission.
    /// </summary>
    [Theory]
    [InlineData("booking.charged")]
    [InlineData("booking.charged_by_payer_override")]
    [InlineData("booking.cancelled_lights_charged")]
    [InlineData("booking.cancelled_lights_adjusted")]
    [InlineData("booking.lit_window_narrowed")]
    [InlineData("booking.payer_reassigned")]
    [InlineData("booking.block_lifted")]
    [InlineData("device.event_time_clamped")]
    [InlineData("device.boot")]
    [InlineData("device.fault")]
    public void The_rows_that_are_not_a_persons_night_are_declared(string action)
        => Assert.Null(TraceKinds.OfAudit(action, actorIsSubject: true));

    /// <summary>
    /// An action nobody has met renders neutrally and NAMES ITSELF — never a guessed sentence,
    /// and never somebody else's.
    /// </summary>
    [Fact]
    public void An_action_with_no_word_is_neutral_and_names_the_raw_string()
    {
        const string invented = "member.teleported";

        Assert.Equal(TraceKinds.Unrecognised, TraceKinds.OfAudit(invented, actorIsSubject: true));

        var headline = TraceKinds.Headline(TraceKinds.Unrecognised, new TraceFacts { RawAction = invented });
        Assert.Contains(invented, headline);

        // It must not have borrowed any other word's sentence.
        foreach (var kind in TraceKinds.All.Where(k => k != TraceKinds.Unrecognised))
        {
            Assert.NotEqual(TraceKinds.Headline(kind, new TraceFacts()), headline);
        }
    }

    /// <summary>Every ledger type this product can post reaches a wallet word.</summary>
    [Fact]
    public void Every_ledger_type_reaches_a_wallet_word()
    {
        foreach (var type in Enum.GetValues<LedgerEntryType>())
        {
            var kind = TraceKinds.OfLedger(type);
            Assert.Contains(kind, TraceKinds.All);
            Assert.NotEqual(TraceKinds.Unrecognised, kind);
            Assert.Equal(TraceKinds.WalletStrand, TraceKinds.StrandOf(kind));
        }
    }

    /// <summary>Every word has a strand and a sentence of its own.</summary>
    [Fact]
    public void Every_word_has_a_strand_and_its_own_sentence()
    {
        var sentences = new Dictionary<string, string>();
        foreach (var kind in TraceKinds.All)
        {
            Assert.NotEmpty(TraceKinds.StrandOf(kind));
            Assert.Contains(TraceKinds.StrandOf(kind), TraceKinds.Strands);

            var sentence = TraceKinds.Headline(kind, new TraceFacts());
            Assert.False(string.IsNullOrWhiteSpace(sentence), $"'{kind}' has no sentence.");
            Assert.False(
                sentences.TryGetValue(sentence, out var already),
                $"'{kind}' and '{already}' render the identical sentence '{sentence}'.");
            sentences[sentence] = kind;
        }
    }

    /// <summary>
    /// A row the club's automatic system wrote SAYS SO IN WORDS — §6.5. A member disputing a
    /// penalty is entitled to the sentence "the club's automatic check did this", not to a
    /// screen that names an administrator who was asleep.
    /// </summary>
    [Fact]
    public void A_system_row_says_so_in_words()
    {
        var system = TraceKinds.Headline(
            TraceKinds.WalletPenalised,
            new TraceFacts { ActorKind = TraceActors.System, AmountCredits = 9m });
        var person = TraceKinds.Headline(
            TraceKinds.WalletPenalised,
            new TraceFacts { ActorKind = TraceActors.Admin, AmountCredits = 9m });

        Assert.NotEqual(person, system);
        Assert.Contains("automatic", system, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("automatic", person, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// D2 §6.2's twenty-one words are all present. An extension is allowed and several exist —
    /// each is declared in <see cref="TraceKinds"/> with its reason — but a word being DROPPED
    /// is a silent contract break for the console that renders it.
    /// </summary>
    [Fact]
    public void The_design_documents_vocabulary_survives_in_full()
    {
        string[] fromD2 =
        [
            "door.opened", "door.refused", "door.opened_offline",
            "booking.made", "booking.made_for_them", "booking.cancelled", "booking.cancelled_by_club",
            "booking.no_show", "booking.blocked_over",
            "walkup.bought", "walkup.refunded",
            "court.checked_in", "court.refused",
            "lights.on", "lights.off",
            "wallet.topped_up", "wallet.spent", "wallet.refunded", "wallet.penalised",
            "wallet.adjusted_by_admin",
            "unrecognised",
        ];

        foreach (var word in fromD2) Assert.Contains(word, TraceKinds.All);
    }

    /// <summary>The vocabulary holds no duplicates — a set that repeats itself is a set nobody counted.</summary>
    [Fact]
    public void The_vocabulary_is_a_set()
        => Assert.Equal(TraceKinds.All.Length, TraceKinds.All.Distinct().Count());
}
