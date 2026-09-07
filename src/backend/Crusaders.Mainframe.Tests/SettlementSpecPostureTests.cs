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
    /// `offline_after_seconds` after the click while every courtside endpoint already answered
    /// 403. Restoring that sentence would authorise the defect again, so it is asserted absent as
    /// well as replaced — the same shape as
    /// <see cref="The_withdrawn_few_minutes_claim_does_not_come_back"/>.
    /// </para>
    ///
    /// <para>
    /// The three-part rule is pinned row by row rather than as a summary, because the middle row
    /// is the one a reader is most likely to drop as redundant and it is the whole of "the switch
    /// does not reach backwards": bounding at the recorded instant ALONE, with no silence test
    /// behind it, re-prices every deadline in `(LastSeenAt, LastSeenAt + offline_after_seconds)`
    /// on the click.
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
}
