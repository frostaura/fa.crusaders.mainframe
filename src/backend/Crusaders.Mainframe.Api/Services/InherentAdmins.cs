namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The deployment's <b>inherent administrators</b>: the addresses in <c>Admins:Emails</c>, read
/// once at startup.
///
/// <para>
/// <b>What being on this list means, stated once so it cannot be read two ways.</b> Whenever a
/// user with one of these addresses exists in a club, that account holds club-admin rights in
/// that club. It does not create accounts, it does not reach clubs the person has never joined,
/// and it confers nothing except the <see cref="Domain.User.IsAdmin"/> flag — see
/// <see cref="InherentAdminService"/>, which is the only thing that acts on it.
/// </para>
///
/// <para>
/// <b>Deployment-owned, not club-owned.</b> It sits in configuration rather than in
/// <c>tenant_settings</c> on purpose, and that is a deliberate exception to "every configurable
/// number is <c>tenant_settings.&lt;key&gt;</c>": a club editing the list of people who can
/// administer every club on the deployment is the thing the list exists to be independent of.
/// The club's own admins are appointed from Admin → Members and are unaffected by this key.
/// </para>
///
/// <para>
/// <b>Security-relevant, but not a secret.</b> It is a list of addresses, and an attacker who
/// reads it learns who to phish rather than how to sign in — nothing here is a credential.
/// Editing it, however, changes who administers the deployment, so it belongs with the values an
/// operator is expected to review, not with the ones they are expected to skim.
/// </para>
///
/// <para>
/// Shaped after <c>ProductionBootstrap.BootstrapPlan.From</c>: one small type that reads its
/// section once, normalises it, and is then passed around as one thing. Same trimming and
/// lower-casing as <c>Bootstrap:AdminEmail</c>, because the comparison it eventually makes is
/// against <c>User.Email</c>, which every ingress has stored lower-cased for far longer than
/// this feature has existed.
/// </para>
/// </summary>
/// <param name="Emails">The accepted addresses, trimmed, lower-cased and de-duplicated.</param>
/// <param name="Ignored">
/// The raw entries that were thrown away, in configuration order, so <see cref="Report"/> can
/// name them. A typo in <c>Admins__Emails__1</c> is otherwise perfectly silent: the address
/// matches nobody, forever, and nothing anywhere says so.
/// </param>
public sealed record InherentAdmins(IReadOnlySet<string> Emails, IReadOnlyList<string> Ignored)
{
    /// <summary>
    /// The configuration key, in the form an operator sets it: <c>Admins__Emails__0</c>.
    ///
    /// <para>
    /// <c>Admins</c> rather than <c>Platform</c>, which would have been the obvious word and is
    /// taken: <see cref="Domain.User.IsPlatformAdmin"/> already means something else — an account
    /// that is not tenant-scoped at all — and a <c>Platform:AdminEmails</c> key that did not set
    /// that flag would be read as a bug by the next person to open either file.
    /// </para>
    /// </summary>
    public const string SectionKey = "Admins:Emails";

    /// <summary>Reads the section. Absent, empty, or entirely malformed are all "nobody".</summary>
    public static InherentAdmins From(IConfiguration config)
    {
        var accepted = new HashSet<string>(StringComparer.Ordinal);
        var ignored = new List<string>();

        foreach (var entry in config.GetSection(SectionKey).GetChildren())
        {
            var candidate = (entry.Value ?? "").Trim().ToLowerInvariant();
            if (candidate.Length == 0 || !LooksLikeAnAddress(candidate))
            {
                ignored.Add(candidate);
                continue;
            }
            accepted.Add(candidate);
        }

        return new InherentAdmins(accepted, ignored);
    }

    /// <summary>Whether an address is on the list, compared the way the database stores it.</summary>
    public bool Includes(string? email) =>
        email is not null && Emails.Contains(email.Trim().ToLowerInvariant());

    /// <summary>
    /// What this deployment is configured to hold, at startup and once.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The count goes to Information; the addresses do not.</b> This is the roster of people
    /// who can administer every club on the deployment, and a container log is read by everyone
    /// who can see the Portainer stack and shipped wherever logs are shipped. The full list is
    /// available at Debug for somebody deliberately looking.
    /// </para>
    /// <para>
    /// What was IGNORED is the opposite case and is a Warning: an operator cannot correct a
    /// typo they have never been told about, and the failure mode — an address that silently
    /// matches nobody — looks exactly like the feature working.
    /// </para>
    /// </remarks>
    public void Report(ILogger logger)
    {
        if (Ignored.Count > 0)
        {
            logger.LogWarning(
                "{Section} ignored {Count} entry/entries that are blank or not email addresses: {Entries}. " +
                "Those people hold no administrator rights from this configuration. Correct or remove them.",
                SectionKey, Ignored.Count, string.Join(", ", Ignored.Select(e => $"'{e}'")));
        }

        if (Emails.Count == 0)
        {
            // An empty or absent list is an ordinary, valid configuration — the club runs on the
            // admins it appointed itself — so this is emphatically not a warning.
            logger.LogDebug("{Section} is empty: no inherent administrators on this deployment.", SectionKey);
            return;
        }

        logger.LogInformation(
            "{Section}: {Count} inherent administrator address(es) configured. Each one holds club-admin " +
            "rights in every club where that address already has an account.", SectionKey, Emails.Count);
        logger.LogDebug("{Section} = {Emails}", SectionKey, string.Join(", ", Emails));
    }

    /// <summary>
    /// The cheap test, kept deliberately close to the one <c>ProductionBootstrap.Validate</c>
    /// applies to <c>Bootstrap__AdminEmail</c> — one <c>@</c> with something on each side — plus
    /// a refusal of embedded whitespace, which is what a comma-separated list pasted into a
    /// single indexed slot looks like.
    ///
    /// <para>
    /// Not a validator. Anything stricter would start refusing addresses that deliver, and the
    /// consequence of accepting a nonsense string here is only that it matches nobody.
    /// </para>
    /// </summary>
    private static bool LooksLikeAnAddress(string candidate) =>
        candidate.Count(c => c == '@') == 1
        && !candidate.StartsWith('@')
        && !candidate.EndsWith('@')
        && !candidate.Any(char.IsWhiteSpace);
}
