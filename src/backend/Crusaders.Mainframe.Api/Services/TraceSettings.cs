namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The two numbers the per-person night trace runs on, read once and bounded on the way out.
///
/// <para>
/// <b>Why a type rather than two properties</b> — the same argument
/// <see cref="DoorSettings"/> makes, and one degree stronger here. The settings PUT is not the
/// only way a value reaches the <c>tenant_settings</c> column: a hand-edited document is, and a
/// restore of an older one is. One of these two numbers is a <b>kill switch on the most
/// surveillance-capable surface in the product</b>, so the question "is the trace on" must have
/// exactly one implementation, and it must be the one that treats an unreadable document as the
/// documented default rather than as whatever <c>JsonElement</c> happened to hold.
/// </para>
///
/// <para>
/// <b>The default is ON, deliberately, and that is not the soft choice.</b> A club that has
/// never opened its settings page must be able to answer "who was here last night" after a
/// break-in, which is the question <c>GOAL.md</c> item 6 exists for; a surface that is off by
/// default is a surface nobody finds on the night they need it. What makes that safe is not the
/// default but the three controls around it — admin-only, no discovery, and one
/// <c>member.trace_viewed</c> row per view in the table nobody can delete from.
/// </para>
/// </summary>
public static class TraceSettings
{
    /// <summary>
    /// Whether this club's admins may read one member's night at all. <b>True.</b>
    ///
    /// <para>
    /// When false the route answers <c>404</c> and not <c>403</c> — a 403 confirms both that the
    /// surface exists and that this member has one, which is the fact a club switching it off is
    /// trying not to publish.
    /// </para>
    /// </summary>
    public const bool DefaultEnabled = true;

    /// <summary>
    /// Most events one trace returns, before the caller pages. Five hundred: a busy member's
    /// whole night is tens of rows, and five hundred covers a month of them without a console
    /// ever meeting the cursor.
    /// </summary>
    public const int DefaultMaxEvents = 500;

    /// <summary>
    /// Fifty. Below that a single evening — arrive, lights on, paid, lights off, leave — starts
    /// to page, and a trace that pages on one night is a trace an admin reads half of.
    /// </summary>
    public const int MinMaxEvents = 50;

    /// <summary>
    /// Two thousand. Past this the merge of three strands stops being the "tens of rows" this
    /// design is costed for and becomes a report, which is a different endpoint.
    /// </summary>
    public const int MaxMaxEvents = 2000;

    /// <summary>Whether the trace answers for this club at all.</summary>
    public static bool Enabled(TenantSettingsView settings) => settings.MemberTraceEnabled;

    /// <summary>Most events one trace returns, clamped to the range its own PUT declares.</summary>
    public static int MaxEvents(TenantSettingsView settings)
        => Math.Clamp(settings.MemberTraceMaxEvents, MinMaxEvents, MaxMaxEvents);
}
