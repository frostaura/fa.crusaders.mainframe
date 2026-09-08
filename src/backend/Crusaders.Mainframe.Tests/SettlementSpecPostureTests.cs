using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The sentences in <c>docs/specs/settlement-model.md</c> that state a NUMBER the code computes,
/// checked against the code that computes it.
/// </summary>
/// <remarks>
/// <para>
/// This exists because the settlement spec has now been wrong about the same number twice, in
/// the same paragraph, in opposite directions. It first asserted that a box inside the band "is
/// a box that still lights the court" — a claim about hardware the API cannot make, withdrawn.
/// Its replacement said the band was "floored at 180 s, so at most a few minutes of silence
/// before the deadline reads as reachable", which is the ceiling of the FLOOR read as the
/// ceiling of the BAND: <see cref="HeartbeatCadence.OfflineAfterSeconds"/> is
/// <c>max(180, clamp(configured, 15, 300) × 3)</c>, so at the cadence ceiling the band is 900 s
/// and a member pays a 30% penalty for a box that had been dead for a quarter of an hour.
/// </para>
/// <para>
/// Both were sentences nothing could fail on. A number in a money spec that no test reads is a
/// number that drifts the first time a constant moves, and the spec is what the next fix is
/// judged against — so the paragraph is now derived from the constants here rather than
/// remembered. Same shape as <see cref="RepositoryPostureTests"/>: read the shipped file in
/// place, never a copy.
/// </para>
/// </remarks>
public sealed class SettlementSpecPostureTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "docs", "specs")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "The repository root was not found above the test binary. This test reads the " +
            "shipped settlement model in place.");
    }

    private static string SettlementModel()
        => File.ReadAllText(Path.Combine(RepoRoot(), "docs", "specs", "settlement-model.md"));

    private static string FeatureSpec()
        => File.ReadAllText(Path.Combine(RepoRoot(), "docs", "specs", "feature-spec.md"));

    /// <summary>
    /// The unprotected band the spec states is the one the code computes, at both ends and in
    /// the formula between them. Change any constant in <see cref="HeartbeatCadence"/> and this
    /// goes red until the paragraph is rewritten to the truth.
    /// </summary>
    [Fact]
    public void The_band_this_spec_states_is_the_band_the_code_computes()
    {
        var text = SettlementModel();

        var formula =
            $"`max({HeartbeatCadence.MinOfflineAfterSeconds}, clamp(heartbeat_seconds, " +
            $"{HeartbeatCadence.MinSeconds}, {HeartbeatCadence.MaxSeconds}) × " +
            $"{HeartbeatCadence.MissedBeatsBeforeOffline})`";
        Assert.Contains(formula, text);

        var defaultBand = HeartbeatCadence.OfflineAfterSeconds(TenantSettingsView.DefaultHeartbeatSeconds);
        Assert.Contains(
            $"**{defaultBand} s at the shipped default\ncadence of {TenantSettingsView.DefaultHeartbeatSeconds} s",
            text.ReplaceLineEndings("\n"));

        var ceilingBand = HeartbeatCadence.OfflineAfterSeconds(HeartbeatCadence.MaxSeconds);
        Assert.Contains($"{ceilingBand} s at the {HeartbeatCadence.MaxSeconds} s\nceiling**", text.ReplaceLineEndings("\n"));

        // The band the accepted-rather-than-bounded decision is about, in minutes, in the
        // sentence that says what it costs a member.
        Assert.Equal(900, ceilingBand);
        Assert.Contains($"gives a box {ceilingBand / 60} minutes of silence", text.ReplaceLineEndings("\n").Replace("\n", " "));
    }

    /// <summary>
    /// The withdrawn claim does not come back. It read as reassurance and was false at the top
    /// of its own range, which is the exact failure mode this file exists for.
    /// </summary>
    [Fact]
    public void The_withdrawn_few_minutes_claim_does_not_come_back()
    {
        Assert.DoesNotContain(
            "at most a\nfew minutes of silence",
            SettlementModel().ReplaceLineEndings("\n"));
        Assert.DoesNotContain("at most a few minutes of silence", SettlementModel());
    }

    /// <summary>
    /// S5a is about the court, not about a box. Both specs have to say so, because the code
    /// that got this wrong (<c>DeviceOutageIndex.CourtWasDark</c> returning true if ANY box was
    /// dark) was written from the looser reading and passed every test in the suite.
    /// </summary>
    [Fact]
    public void Both_specs_define_the_waiver_over_every_box_on_the_court()
    {
        var settlement = SettlementModel().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("**How many boxes have to be dark: all of them.**", settlement);
        Assert.Contains("| S5a | `NoShow` — swept while the court had **no reachable box** |", settlement);
        Assert.Contains("A court the club has put no box on at all is not dark", settlement);

        // The other half of the same sentence, added when taking the LAST box off a court was
        // found to charge that court's members the full penalty (finding M-F3). The pin is here
        // because the sentence it replaced was the one the code was written from, and a spec
        // that says only "no enabled box, not dark" reads as a licence to put the defect back.
        Assert.Contains(
            "**A court whose boxes have ALL been switched out of service is a different state, and it IS dark.**",
            settlement);

        var feature = FeatureSpec().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("applied to **every** enabled box that drives the court", feature);
    }

    /// <summary>
    /// <b>The out-of-service clause is bounded in time, and both specs have to say so.</b>
    ///
    /// <para>
    /// The clause above shipped unbounded and re-priced deadlines that had already been settled
    /// on working hardware: `Enabled` carries no history, so "dark because it is switched off"
    /// was read as "dark for as far back as this board has existed". This pin is here for the
    /// same reason the one above it is — the unbounded sentence is what the code was written
    /// from, and a spec that says only "a court whose boxes are all out of service is dark"
    /// reads as a licence to put the retroactive version back.
    /// </para>
    ///
    /// <para>
    /// It also pins the row that made the defect invisible. The pin table listed "A board
    /// switched off after the deadline does not speak for it" against a test that varies
    /// `installedAt`, i.e. a board CREATED after the deadline — a different fact, so the
    /// sentence was carried by nothing. The corrected row names the switch-off explicitly.
    /// </para>
    /// </summary>
    [Fact]
    public void Both_specs_bound_the_out_of_service_waiver_by_the_boards_own_silence()
    {
        var settlement = SettlementModel().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("**But the switch itself does not reach backwards", settlement);
        Assert.Contains("A board **registered** after the deadline does not speak for it", settlement);
        Assert.DoesNotContain("| A board switched off after the deadline does not speak for it |", settlement);

        var feature = FeatureSpec().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("**The switch is not retroactive**", feature);
    }

    /// <summary>
    /// <b>The other end of the same bound: the switch is not DELAYED either, and both specs have
    /// to say which instant it is measured from.</b>
    ///
    /// <para>
    /// The sentence this replaces — "The switch-off instant IS recorded — as `LastSeenAt` on the
    /// switched-off row" — was the one the shipped code was written from, and it was false in a
    /// way that cost members money: the switch lands after the board's last heartbeat, not on it,
    /// so bounding the branch by the board's silence left the court reading Lit for up to
    /// `offline_after_seconds` after the click while the board itself was already answering 403 on
    /// every route it calls. Restoring that sentence would authorise the defect again, so it is asserted absent as
    /// well as replaced — the same shape as
    /// <see cref="The_withdrawn_few_minutes_claim_does_not_come_back"/>.
    /// </para>
    ///
    /// <para>
    /// The rule is pinned row by row rather than as a summary, because the first row is the one a
    /// reader is most likely to drop as redundant and it is the whole of "the switch does not
    /// reach backwards": bounding at the recorded instant ALONE, with no silence test behind it,
    /// re-prices every deadline in `(LastSeenAt, LastSeenAt + offline_after_seconds)` on the
    /// click.
    /// </para>
    ///
    /// <para>
    /// <b>The table had three rows for a round and one of them was false.</b> It split the first
    /// row in two and called everything at or before the board's last heartbeat "Lit — positive
    /// proof it was in service". The code does not do that: `DoorWasShutFor` falls through to
    /// `BoxWasUnreachable`, which scans every recorded silence including closed `DeviceOutage`
    /// rows earlier than `LastSeenAt`, and
    /// `A_board_dark_across_the_deadline_still_waives_it_after_an_admin_switches_it_off` is a
    /// green test in this repository whose deadline sits before its board's last heartbeat and
    /// which asserts a full refund. The spec said Lit, the ledger said dark, and both were green
    /// because nothing read that row. The withdrawn wording is asserted absent as well as
    /// replaced.
    /// </para>
    /// </summary>
    [Fact]
    public void Both_specs_measure_the_switch_off_from_the_recorded_instant_and_not_from_a_heartbeat()
    {
        var settlement = SettlementModel().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("**The switch-off instant is recorded, and it is its own column.**", settlement);
        Assert.Contains("`devices.OutOfServiceSince`", settlement);
        Assert.Contains(
            "**It is not `LastSeenAt`, and this document said for one round that it was.**", settlement);
        Assert.Contains("**Judged by `offline_after_seconds`**", settlement);
        Assert.Contains("**Out of service, at once.**", settlement);

        // Two rows, one on each side of the click — not three, and the first one is not "Lit".
        Assert.Contains(
            "**So the rule is two parts, one on each side of the click", settlement);
        Assert.Contains(
            "**The first row is not \"Lit\", and an earlier version of this table said it was.**",
            settlement);
        Assert.Contains(
            "`A_board_dark_across_the_deadline_still_waives_it_after_an_admin_switches_it_off`",
            settlement);
        Assert.DoesNotContain("**So the rule is three parts", settlement);
        Assert.DoesNotContain(
            "| `D` at or before the board's last heartbeat | **Lit.**", settlement);
        Assert.DoesNotContain("there is positive proof it was in service", settlement);

        // The boundary the rule turns on, stated in the spec because the comparison itself was
        // unguarded: weakening `instant > switchedOffAt` to `>=` reddened nothing until
        // A_deadline_exactly_on_the_recorded_switch_off_instant_is_judged_by_the_silence_test.
        Assert.Contains(
            "a deadline landing exactly on `S` is on the near side and is judged by the row above",
            settlement);

        // The withdrawn sentence. It reads as a settled fact and is the one the shipped defect
        // was written from.
        Assert.DoesNotContain(
            "**The switch-off instant IS recorded — as `LastSeenAt` on the switched-off row.**", settlement);

        var feature = FeatureSpec().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains(
            "**That half is bounded, and it took three tries to bound it in the right place**", feature);
        Assert.Contains("**Nor is it delayed**", feature);
        Assert.Contains("`devices.OutOfServiceSince`", feature);
        Assert.DoesNotContain(
            "**That half is bounded by the same silence test, and the first version of it was not**", feature);
    }

    /// <summary>
    /// The waiver mail's own paragraph in the settlement model, which changed with the rule
    /// behind it: a court is out of service from the click, so the notice can no longer open
    /// "No court box was answering". A spec that still says it can is a spec the next fix will
    /// restore the sentence from.
    /// </summary>
    [Fact]
    public void The_settlement_model_records_why_the_out_of_service_notice_changed_its_opening()
    {
        var settlement = SettlementModel().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains(
            "**The out-of-service notice no longer opens \"No court box was answering\", and " +
            "recording the switch-off instant is what made that sentence false.**", settlement);
        Assert.Contains("`Every_sentence_of_the_out_of_service_waiver_mail`", settlement);
        Assert.Contains("`Every_sentence_of_the_outage_waiver_mail`", settlement);
    }

    /// <summary>
    /// <b>The two specs agree about what <c>bookings.cancellation_reason</c> is, and §11's
    /// reason-is-not-the-waiver rule cannot be quietly reverted.</b>
    ///
    /// <para>
    /// Two separate failures, one pin, because they were the same paragraph. §11 was amended
    /// to say the reason and the waiver are separate facts — overturning an earlier rule that
    /// gated the reason on the waiver and so deleted the desk's own words from the audit row
    /// and the mail together. The four tests written with it pin the CODE. Nothing pinned the
    /// TEXT: a verifier replaced the new clause with the exact wording it was written to
    /// overturn and both suites stayed green, so a later reader could restore the rule the
    /// round was spent removing with every gate passing.
    /// </para>
    ///
    /// <para>
    /// The same amendment justified itself with "<c>bookings.cancellation_reason</c> is a
    /// column nothing writes", which is false and was written into the money domain. The
    /// column is <see cref="BookingService.ResoldTailRefunded"/> or null — written by the
    /// displacement path, cleared by the reinstatement, and read back by
    /// <c>ChargeLitCancelledBookingAsync</c> and <c>SettleReleaseAsync</c> as the
    /// discriminator this model defines the Displaced state by at S8 and I5. So the two specs
    /// contradicted each other about a money field, and the hand-off invited a follow-up to
    /// remove it as dead schema. The constant is interpolated here rather than spelled out, so
    /// renaming it reds this until both specs are rewritten to the truth.
    /// </para>
    /// </summary>
    [Fact]
    public void Both_specs_agree_what_the_cancellation_reason_column_is()
    {
        var feature = FeatureSpec().ReplaceLineEndings("\n").Replace("\n", " ");
        var settlement = SettlementModel().ReplaceLineEndings("\n").Replace("\n", " ");

        // §11's rule, in the words the code was written from.
        Assert.Contains(
            "**The reason and the waiver are two separate facts and are not gated on each other**",
            feature);
        // The rule it overturned does not come back. This is the mutation that stayed green.
        Assert.DoesNotContain(
            "The reason belongs to the waiver and is recorded only when one actually happened",
            feature);

        // The false premise does not come back either, in either spec.
        Assert.DoesNotContain("is a column nothing writes", feature);
        Assert.DoesNotContain("is a column nothing writes", settlement);
        Assert.DoesNotContain("no service writes", feature);
        Assert.DoesNotContain("no service writes", settlement);

        // What §11 says instead, tied to the constant the money path compares against.
        Assert.Contains(
            "**`bookings.cancellation_reason` is not a second copy of it, and it is not free text**",
            feature);
        Assert.Contains(
            $"the resale path writes `{BookingService.ResoldTailRefunded}` into it and "
                + "`settlement-model.md` I5/S8 read it back",
            feature);
        Assert.Contains("the admin-cancel path writes nothing to it at all", feature);

        // And the money oracle still defines the Displaced state by that same constant, in
        // all three places §11 now points at.
        Assert.Contains($"`CancellationReason == \"{BookingService.ResoldTailRefunded}\"`", settlement);
        Assert.Contains($"| S8 | **Displaced** (`{BookingService.ResoldTailRefunded}`) | `0`, unconditionally |", settlement);
        Assert.Contains($"`CancellationReason == {BookingService.ResoldTailRefunded}` ⇒ `Owed = 0`", settlement);

        // The invitation to treat it as removable is closed off from the money side too.
        Assert.Contains(
            "**The column is a closed marker with one owner, not a note field and not dead schema.**",
            settlement);
        Assert.Contains("an admin cancelling on a member's behalf does not, and must not", settlement);
    }

    /// <summary>
    /// <b>The waiver's justification, which was false in both specs and in the mail it explains.</b>
    ///
    /// <para>
    /// Three documents and one user-visible sentence claimed that once the last box on a court is
    /// switched off "every courtside endpoint answers 403" and "nobody standing there can check in
    /// by heartbeat, activation, walk-up, PIN, QR or biometric". One grep disproves it:
    /// <c>grep -rn '"/api/v1/court' src/backend/Crusaders.Mainframe.Api --include="*.cs"</c>
    /// returns <c>PinEndpoints.cs</c>, <c>QrEndpoints.cs</c> and <c>BiometricEndpoints.cs</c>, and
    /// none of the three mentions <c>Devices</c>, <c>Enabled</c> or <c>IsActive</c> — they resolve
    /// a <c>Courts.CourtNumber</c>, authenticate as the shared courtside terminal's admin role and
    /// still set <c>CheckedInAt</c>. Three of the six named ways in survive the switch.
    /// </para>
    ///
    /// <para>
    /// The rule did not change; its justification did, and a money oracle that argues from a false
    /// premise is what the next fixer re-derives the rule from. So the spec now narrows the claim
    /// to the four <c>/api/v1/device/*</c> routes, states plainly that the door is not shut
    /// everywhere, and ARGUES the waiver instead of asserting it — including the cost of keeping
    /// it. This pins all three, and asserts the withdrawn claims absent so they cannot be restored
    /// with every gate green, which is exactly what happened to their predecessor.
    /// </para>
    /// </summary>
    [Fact]
    public void Both_specs_narrow_the_403_claim_to_the_boxs_own_routes_and_argue_the_waiver()
    {
        var settlement = SettlementModel().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains(
            "**The door is not shut everywhere, and this document said for two rounds that it was.**",
            settlement);
        Assert.Contains(
            "**The waiver still stands, and this is the argument rather than the assertion.**",
            settlement);
        Assert.Contains("**The cost of that choice, stated rather than implied:**", settlement);
        Assert.Contains("`/api/v1/court/{n}/pin/match`", settlement);
        Assert.Contains("`CheckedInAt == null`", settlement);

        // The withdrawn claims. Both read as settled fact and both were pinned to the letter
        // while being false, which made them harder to remove rather than easier.
        Assert.DoesNotContain(
            "every courtside endpoint answers `403` from that instant", settlement);
        Assert.DoesNotContain(
            "nobody standing at that court can check in by heartbeat, activation, walk-up, PIN, " +
            "QR or biometric", settlement);

        var feature = FeatureSpec().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("**It is the box that is shut, not the court**", feature);
        Assert.DoesNotContain(
            "on every courtside endpoint and nobody standing there can check in by any means",
            feature);
        Assert.DoesNotContain("nobody standing there can check in by any means", feature);
    }

    /// <summary>
    /// <b>What a finished off-period leaves behind, which this spec argued backwards.</b> The
    /// paragraph said "`PeripheralHealthWorker` does not alert on a disabled board, so no
    /// `DeviceOutage` row covers it either". The premise is true and the conclusion does not
    /// follow: <c>DeviceSilenceLog.NoteHeartbeat</c> writes a closed row on the board's first
    /// heartbeat AFTER it is put back in service, starting at the last heartbeat before the switch
    /// — so the recorded silence is wider than the off-period, and the gap the paragraph described
    /// is narrower than it stated. Pinned in behaviour by
    /// <c>A_finished_off_period_is_covered_by_the_outage_row_the_boards_return_writes</c>; this is
    /// the pin on the sentence, which had none of its own.
    /// </summary>
    [Fact]
    public void The_settlement_model_says_what_actually_records_a_finished_off_period()
    {
        var settlement = SettlementModel().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("`DeviceSilenceLog.NoteHeartbeat`", settlement);
        Assert.Contains(
            "So the recorded silence is **never narrower than the off-period, and normally wider**",
            settlement);
        Assert.Contains(
            "`A_finished_off_period_is_covered_by_the_outage_row_the_boards_return_writes`",
            settlement);
        Assert.DoesNotContain("so no `DeviceOutage` row covers it either", settlement);
    }

    /// <summary>
    /// <b>The column the spec names is the column that exists.</b> §8b called it
    /// <c>out_of_service_since</c> — a name that, before this fix, appeared exactly once in the
    /// whole repository: in that sentence. (Grep it today and the only hits are in this file,
    /// which asserts it absent from both specs.) The column is <c>OutOfServiceSince</c>,
    /// PascalCase like every other column on
    /// <c>devices</c>, and the same document had it right eighty lines earlier at §6a, where it was
    /// pinned. A spec identifier nothing reads is one a reader cannot resolve and a fixer will
    /// "correct" the code towards.
    /// </summary>
    [Fact]
    public void The_feature_spec_names_the_switch_off_column_the_way_the_schema_does()
    {
        var feature = FeatureSpec().ReplaceLineEndings("\n").Replace("\n", " ");
        // Anchored on each site's own surrounding words rather than on a count, so a third
        // mention added later does not red this spuriously — the claim is "both places name it
        // correctly", not "it appears exactly twice".
        Assert.Contains(
            "recorded in its own column** (`devices.OutOfServiceSince`, stamped by " +
            "`DeviceRegistryService.UpdateAsync`", feature);
        Assert.Contains("recorded on the row as `devices.OutOfServiceSince`", feature);
        Assert.DoesNotContain("out_of_service_since", feature);
        Assert.DoesNotContain("out_of_service_since", SettlementModel());
    }

    /// <summary>
    /// <b>Every test the settlement model's pin tables name is a test that exists.</b>
    ///
    /// <para>
    /// This document holds its rules together with tables of the form
    /// <c>| clause | `Test_name` |</c>, and it has already shipped a row whose pin was a test
    /// about a different fact — "A board switched off after the deadline does not speak for it",
    /// pinned against a test that varies <c>installedAt</c>. That one was a wrong pin rather than
    /// a missing one, which no mechanical check can catch. A pin that names a test which no
    /// longer exists CAN be caught, and it is the cheaper half of the same failure: a rename in
    /// the test project leaves the table pointing at nothing, silently, with every gate green,
    /// and the next reader concludes the clause is unguarded — or worse, that it is guarded.
    /// </para>
    ///
    /// <para>
    /// Only table rows are read, not the prose: the narrative deliberately quotes WITHDRAWN test
    /// names when it explains what a rule used to be, and those must not resolve. The count
    /// assertion is there because a regex that stops matching is a gate that always passes, which
    /// this repository has shipped three times.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_test_the_settlement_models_pin_tables_name_exists()
    {
        var cited = new SortedSet<string>();
        foreach (var row in SettlementModel().ReplaceLineEndings("\n").Split('\n')
                     .Where(l => l.StartsWith('|')))
        {
            foreach (System.Text.RegularExpressions.Match m in
                     System.Text.RegularExpressions.Regex.Matches(
                         row, "`([A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){3,})`"))
            {
                cited.Add(m.Groups[1].Value);
            }
        }

        // A gate that reads nothing is a gate that cannot fail. The tables carried 26 names when
        // this was written; the floor is deliberately loose so removing a clause does not red it.
        Assert.True(cited.Count >= 20, $"only {cited.Count} pins were read out of the tables");

        var declared = typeof(SettlementSpecPostureTests).Assembly.GetTypes()
            .SelectMany(t => t.GetMethods(
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance |
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.DeclaredOnly))
            .Select(m => m.Name)
            .ToHashSet(StringComparer.Ordinal);

        var missing = cited.Where(n => !declared.Contains(n)).ToList();
        Assert.True(missing.Count == 0,
            "settlement-model.md pins tests that do not exist: " + string.Join(", ", missing));
    }
}
