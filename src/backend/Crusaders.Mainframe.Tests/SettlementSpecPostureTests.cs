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
        Assert.Contains("**The switch-off instant IS recorded — as `LastSeenAt` on the switched-off row.**", settlement);
        Assert.Contains("A board **registered** after the deadline does not speak for it", settlement);
        Assert.DoesNotContain("| A board switched off after the deadline does not speak for it |", settlement);

        var feature = FeatureSpec().ReplaceLineEndings("\n").Replace("\n", " ");
        Assert.Contains("**The switch is not retroactive**", feature);
        Assert.Contains("**That half is bounded by the same silence test, and the first version of it was not**", feature);
    }
}
