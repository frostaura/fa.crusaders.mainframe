using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What the notices about one result need to say who, where and when.</summary>
/// <param name="Names">Display names by member id (every member in the lineup, and the actor).</param>
/// <remarks>Its own file: beside <see cref="PlayNotices"/> lizard read the record as a file-long *global* (gotchas-gates).</remarks>
public sealed record ResultContext(Booking Booking, string CourtName, TenantSettingsView Settings, IReadOnlyDictionary<Guid, string> Names)
{
    public string NameOf(Guid userId) => Names.TryGetValue(userId, out var n) ? n : "A member";

    /// <summary>The club-local <c>Tue 30 Sep, 18:00</c> of the match.</summary>
    public string When => PlayNotices.Local(Booking.StartsAt, Settings);
}
