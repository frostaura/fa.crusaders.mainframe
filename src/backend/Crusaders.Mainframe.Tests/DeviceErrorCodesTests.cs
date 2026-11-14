using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The closed fault vocabulary, pinned against both maps that read it.
///
/// <para>
/// <b>A code added and forgotten is the failure this class exists to catch.</b> Both
/// <see cref="DeviceErrorCodes.SeverityOf"/> and <see cref="DeviceErrorCodes.HeadlineOf"/> end in
/// a fallback arm, which is correct — a firmware ahead of this server must not crash the
/// monitoring page — and which also means a code that never got an entry is INVISIBLE at
/// runtime: it grades silently as <c>Error</c> and renders as "an error the club's software does
/// not have a name for", on a page whose whole job is to be specific about which board is
/// broken.
/// </para>
///
/// <para>
/// So the expectation lives HERE, as a table this file owns, and every code in
/// <see cref="DeviceErrorCodes.All"/> is looked up in it. Adding a code to the vocabulary
/// without adding it here fails <see cref="Every_code_has_an_explicitly_expected_severity"/>;
/// adding it here without the production switch fails the same test from the other side.
/// <see cref="The_severity_pin_rejects_a_code_that_was_never_graded"/> proves the check can
/// actually go red, rather than being a loop over a list that happens to agree with itself.
/// </para>
/// </summary>
public sealed class DeviceErrorCodesTests
{
    /// <summary>
    /// What a club is told when the code means nothing to this server. Duplicated from the
    /// production switch on purpose: a test that read the fallback from the same expression it is
    /// checking against could not tell a real headline from the fallback.
    /// </summary>
    private const string Fallback = "An error the club's software does not have a name for";

    /// <summary>
    /// Every code and the severity it must grade as. <b>The table is the test.</b>
    /// </summary>
    private static readonly Dictionary<string, DeviceErrorSeverity> Expected = new(StringComparer.Ordinal)
    {
        // Critical — the club cannot sell or deliver court time until somebody attends.
        [DeviceErrorCodes.RelayCmdDropped] = DeviceErrorSeverity.Critical,
        [DeviceErrorCodes.RestoreFailed] = DeviceErrorSeverity.Critical,
        [DeviceErrorCodes.RestoreNotConfirmed] = DeviceErrorSeverity.Critical,
        [DeviceErrorCodes.MegaLinkLost] = DeviceErrorSeverity.Critical,

        // Error — a board is failing at something it is for.
        [DeviceErrorCodes.SerialBadCrc] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.SerialBadFrame] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.SerialOverrunRx] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.SerialOverrunTx] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.SerialBadVerb] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.SerialBadArg] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.SerialNoCourt] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.OnNotAcked] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.ExtRefused] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.LcdI2cTimeout] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.WdtReset] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.StoreWriteFailed] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.Http5xx] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.ApiBreakerOpen] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.ScannerUartError] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.NvsWriteFailed] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.RelockOverdue] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.AuthFailed] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.CourtNotMapped] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.Unknown] = DeviceErrorSeverity.Error,

        // Warning — degraded, self-correcting, or a rule the club set being hit.
        [DeviceErrorCodes.LcdResync] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.QueueOverflow] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.RosterRejected] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.Http4xx] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.HttpTimeout] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.HeartbeatRejected] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.ClockCorrected] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.FaultOverflow] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.ScanOversize] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.ButtonUnauthorised] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.UnlockClamped] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.UnregisteredMac] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.MalformedBody] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.ClockClamped] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.EventRejected] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.SeqRegression] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.OutageOpened] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.WalkupRefused] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.ActivationRefused] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.TooManyUnacknowledgedDevices] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.QueueNoPush] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.QueueEventsLost] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.ErrorLogOverflow] = DeviceErrorSeverity.Warning,

        // Device contract v3 (device-api.md §4, §13; serial v3; door-gate §14).
        [DeviceErrorCodes.RelightFailed] = DeviceErrorSeverity.Critical,
        [DeviceErrorCodes.MegaUnacked] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.KindMismatch] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.BoardRestarted] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.LcdAbsent] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.ScreenDropped] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.HeapLow] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.StackLow] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.AnswerDrift] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.CodeKeysTrimmed] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.LightsOnNothingBooked] = DeviceErrorSeverity.Warning,
        [DeviceErrorCodes.CheckedInLightsOff] = DeviceErrorSeverity.Error,
        [DeviceErrorCodes.NetFallback] = DeviceErrorSeverity.Warning,

        // Info — worth counting, not worth waking anybody.
        [DeviceErrorCodes.MegaLinkBack] = DeviceErrorSeverity.Info,
        [DeviceErrorCodes.Boot] = DeviceErrorSeverity.Info,
    };

    /// <summary>
    /// The ungraded codes in a list: those this file's table has no entry for. Written as a
    /// function over an ARBITRARY list rather than over <see cref="DeviceErrorCodes.All"/>, so the
    /// same check can be shown to go red — see
    /// <see cref="The_severity_pin_rejects_a_code_that_was_never_graded"/>.
    /// </summary>
    private static List<string> Ungraded(IEnumerable<string> codes)
        => [.. codes.Where(c => !Expected.ContainsKey(c))];

    /// <summary>
    /// Every fault the firmware can raise is a code this server stores as itself. A board ahead of
    /// the server is filed as <c>unknown</c> by design — but a code both sides ship in the same
    /// release must not be, and the integration of the v3 lanes found <c>net_fallback</c> (a door
    /// that abandoned a network it was sent) filed as <c>unknown</c> on every occurrence. The
    /// firmware's own tables are read, so a fault added there without a server entry goes red here.
    /// </summary>
    [Fact]
    public void Every_fault_the_firmware_raises_is_a_code_the_server_knows()
    {
        var iot = Path.Combine(RepoRoot(), "src", "iot");
        var bridge = File.ReadAllText(Path.Combine(iot, "court-box", "lib", "bridgelogic", "src", "FaultLog.cpp"));
        var table = bridge[bridge.IndexOf('{', bridge.IndexOf("kFaultNames", StringComparison.Ordinal))..];
        table = table[..table.IndexOf("};", StringComparison.Ordinal)];
        var gate = File.ReadAllText(Path.Combine(iot, "door-gate", "lib", "gatelogic", "include", "gatelogic", "FaultLog.h"));

        var raised = System.Text.RegularExpressions.Regex.Matches(table, "\"([a-z0-9_]+)\"").Select(m => m.Groups[1].Value)
            .Concat(System.Text.RegularExpressions.Regex.Matches(gate, "inline constexpr char kFault(?!BootReasonPrefix)\\w+\\[\\] = \"([a-z0-9_]+)\";")
                .Select(m => m.Groups[1].Value))
            .Distinct().ToList();

        Assert.Contains("mega_unacked", raised);
        Assert.Contains("net_fallback", raised);
        var unknown = raised.Where(code => !DeviceErrorCodes.IsKnown(code)).ToList();
        Assert.True(unknown.Count == 0, $"filed as unknown: {string.Join(", ", unknown)}");
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CLAUDE.md"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("repository root not found");
    }

    [Fact]
    public void Every_code_has_an_explicitly_expected_severity()
    {
        Assert.Empty(Ungraded(DeviceErrorCodes.All));

        foreach (var code in DeviceErrorCodes.All)
        {
            Assert.Equal(Expected[code], DeviceErrorCodes.SeverityOf(code));
        }
    }

    /// <summary>
    /// The mutant: a code in the vocabulary that nobody graded. The check has to notice, or the
    /// test above is a loop that agrees with itself.
    /// </summary>
    [Fact]
    public void The_severity_pin_rejects_a_code_that_was_never_graded()
    {
        var withAForgottenCode = DeviceErrorCodes.All.Append("relay_welded_shut");

        Assert.Equal(["relay_welded_shut"], Ungraded(withAForgottenCode));

        // And the forgotten code is exactly as invisible at runtime as this class claims: it
        // grades Error and reads as the fallback, which is why the table above is necessary.
        Assert.Equal(DeviceErrorSeverity.Error, DeviceErrorCodes.SeverityOf("relay_welded_shut"));
        Assert.Equal(Fallback, DeviceErrorCodes.HeadlineOf("relay_welded_shut"));
    }

    /// <summary>
    /// Every code reads as a sentence, and only <see cref="DeviceErrorCodes.Unknown"/> is allowed
    /// to be the fallback — because for that one code the fallback IS the right sentence.
    /// </summary>
    [Fact]
    public void Every_code_has_a_headline_that_is_not_the_fallback()
    {
        foreach (var code in DeviceErrorCodes.All.Where(c => c != DeviceErrorCodes.Unknown))
        {
            var headline = DeviceErrorCodes.HeadlineOf(code);
            Assert.False(string.IsNullOrWhiteSpace(headline), $"{code} has no headline");
            Assert.NotEqual(Fallback, headline);

            // A headline is for a volunteer admin, so it must not be the code wearing spaces.
            Assert.DoesNotContain(code, headline, StringComparison.OrdinalIgnoreCase);
        }

        Assert.Equal(Fallback, DeviceErrorCodes.HeadlineOf(DeviceErrorCodes.Unknown));
    }

    /// <summary>
    /// The vocabulary itself: no duplicates, and nothing the column cannot hold. A duplicate
    /// would make the severity table above pass while one of the two entries was dead.
    /// </summary>
    [Fact]
    public void The_vocabulary_is_distinct_lowercase_and_fits_the_column()
    {
        Assert.Equal(DeviceErrorCodes.All.Count, DeviceErrorCodes.All.Distinct(StringComparer.Ordinal).Count());

        foreach (var code in DeviceErrorCodes.All)
        {
            Assert.Equal(code.ToLowerInvariant(), code);
            Assert.InRange(code.Length, 1, DeviceError.MaxCodeLength);
            Assert.True(DeviceErrorCodes.IsKnown(code), $"{code} is in All and not in Known");
        }
    }

    /// <summary>
    /// <b>Normalise is what an admin's <c>?code=</c> filter and the ingest both run through.</b>
    /// A code this server has never heard of becomes <c>unknown</c> rather than disappearing, and
    /// a known one round-trips whatever case and whitespace it arrived in.
    /// </summary>
    [Theory]
    [InlineData("scanner_uart_error", "scanner_uart_error")]
    [InlineData("  SCANNER_UART_ERROR  ", "scanner_uart_error")]
    [InlineData("bridge_desync", DeviceErrorCodes.Unknown)]
    [InlineData("", DeviceErrorCodes.Unknown)]
    [InlineData(null, DeviceErrorCodes.Unknown)]
    public void An_unknown_code_normalises_to_unknown_and_a_known_one_survives(string? reported, string expected)
    {
        Assert.Equal(expected, DeviceErrorCodes.Normalise(reported));
        Assert.False(DeviceErrorCodes.IsKnown("bridge_desync"));
    }
}
