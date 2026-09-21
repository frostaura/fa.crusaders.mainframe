using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The name this club knows a person by — the ONE name this product ever shows one person about
/// another, resolved for a whole page in a single read.
///
/// <para>
/// <b>Name only.</b> The booking grid's rule is the product's rule: no email, no phone, no
/// membership number reaches another member's screen, and an admin surface is not an exemption
/// from it — it is where the temptation is. A projection that selected the membership row would
/// carry all four.
/// </para>
///
/// <para>
/// <b>One read per page, never one per row.</b> The doors overview lists every gate and the log
/// lists fifty rows; a name resolved inside the projection is a query each. Written here rather
/// than a fourth time because a fourth copy is where one of them starts selecting a different
/// column.
/// </para>
///
/// <para>
/// <b>An admin's own name is a member's name and is read from the same place</b> — every admin
/// in this product is a member of the club they administer. A row whose actor is
/// <see cref="Guid.Empty"/> is the BOARD, not a person, and resolves to null, which is what lets
/// a door's feed say "registered itself" rather than naming somebody who was not there.
/// </para>
/// </summary>
public static class PersonNames
{
    /// <summary>The names for one page's worth of people, in one read. Ids that name nobody are absent.</summary>
    public static async Task<Dictionary<Guid, string>> ForAsync(
        MainframeDbContext db, IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var wanted = ids
            .Where(i => i is { } value && value != Guid.Empty)
            .Select(i => i!.Value).Distinct().ToList();
        if (wanted.Count == 0) return [];

        return await db.Memberships.AsNoTracking()
            .Where(m => wanted.Contains(m.UserId))
            .Select(m => new { m.UserId, m.FullName })
            .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);
    }

    /// <summary>
    /// One name out of a resolved page, or null — for nobody, for the board, and for a person
    /// this club has no membership row for. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </summary>
    public static string? Of(Guid? id, IReadOnlyDictionary<Guid, string> names)
    {
        if (id is not { } value || value == Guid.Empty) return null;
        return names.TryGetValue(value, out var name) ? name : null;
    }

    /// <summary>Shortest full name this product will store. Two characters.</summary>
    public const int MinFullNameLength = 2;

    /// <summary>
    /// Longest full name this product will store.
    ///
    /// <para>
    /// <b>It was enforced on ONE of the two ways in (D-L4 / R3-37).</b> <c>PUT /me/profile</c>
    /// has bounded the field at 120 since it shipped; <c>POST /auth/register</c>, which is how
    /// every membership row in the product is actually created, checked only that the string
    /// was not whitespace and handed it straight to a <c>varchar(255)</c> — so a name of four
    /// hundred characters of markup either landed whole or came back as an unhandled <c>500</c>
    /// out of <c>SaveChangesAsync</c>, depending on which side of 255 it fell. The name then
    /// appears on the booking grid, in the door log, in the CSV export and in every admin
    /// email, so it is the string with the widest blast radius in the product and it was the
    /// one with no bound at the door.
    /// </para>
    ///
    /// <para>
    /// 120 rather than the column's 255, because the bound that matters is the one a club's
    /// screens can render; and below the column either way, so the database is never the thing
    /// that refuses. The cap is length only — markup is not stripped, because every surface
    /// that renders a name escapes it and a product that silently rewrites a member's own name
    /// is worse than one that asks them to shorten it.
    /// </para>
    /// </summary>
    public const int MaxFullNameLength = 120;

    /// <summary>The refusal for a full name outside the bounds above. One code for both ends.</summary>
    public const string FullNameInvalid = "full_name_invalid";

    /// <summary>
    /// Whether an already-trimmed full name is one this product will store. Block body for the
    /// lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    public static bool IsAcceptable(string? trimmed)
    {
        if (trimmed is null) return false;
        return trimmed.Length >= MinFullNameLength && trimmed.Length <= MaxFullNameLength;
    }
}
