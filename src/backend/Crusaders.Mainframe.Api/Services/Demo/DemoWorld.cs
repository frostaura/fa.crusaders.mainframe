using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>A made-up person, as the generator plans them before any row exists.</summary>
internal sealed class DemoPerson
{
    public required Guid UserId { get; init; }
    public required string Name { get; init; }
    public required DateTimeOffset JoinedAt { get; init; }

    /// <summary>How often they book, relative to everyone else.</summary>
    public double Weight { get; init; } = 1;

    /// <summary>Plays before work rather than after it.</summary>
    public bool EarlyBird { get; init; }
    public bool IsMirror { get; init; }
    public Guid? GroupId { get; set; }
    public List<DemoPerson> Friends { get; } = [];

    /// <summary>Club days they already organise a game on (one a day keeps them inside the daily cap).</summary>
    public HashSet<DateOnly> OrganisedOn { get; } = [];

    /// <summary>Every interval they are on court, by club day, so nobody plays two games at once.</summary>
    private readonly Dictionary<DateOnly, List<(DateTimeOffset Start, DateTimeOffset End)>> _busy = [];

    public bool IsFree(DateOnly day, DateTimeOffset start, DateTimeOffset end) =>
        !_busy.TryGetValue(day, out var spans) || spans.All(b => b.End <= start || end <= b.Start);

    public void Occupy(DateOnly day, DateTimeOffset start, DateTimeOffset end)
    {
        if (!_busy.TryGetValue(day, out var spans)) _busy[day] = spans = [];
        spans.Add((start, end));
    }
}

/// <summary>One money movement on the generator's timeline, before it becomes a ledger row.</summary>
internal sealed record DemoMoney(DateTimeOffset At, Guid UserId, LedgerEntryType Type, int Minutes, string Reason)
{
    public Guid? BookingId { get; init; }
    public string? Reference { get; init; }
    public Guid ActorUserId { get; init; }
}

/// <summary>Everything the generator knows about the club it is filling, and the dice it rolls.</summary>
internal sealed class DemoWorld
{
    public required Random Rng { get; init; }
    public required DateTimeOffset Now { get; init; }
    public required Guid TenantId { get; init; }
    public required TenantSettingsView Settings { get; init; }
    public required List<Court> Courts { get; init; }
    public required List<MemberGroup> Groups { get; init; }
    public required List<MinutePackage> Packages { get; init; }

    /// <summary>The demo's own admins — the mirrors. The first is the actor of anything the club did.</summary>
    public required List<User> Mirrors { get; init; }

    /// <summary>Everyone who plays: active members and the mirrors.</summary>
    public List<DemoPerson> Players { get; } = [];

    /// <summary>Court time already taken (schedule blocks, then each planned booking), by court and club day.</summary>
    private readonly Dictionary<(Guid CourtId, DateOnly Day), List<(DateTimeOffset Start, DateTimeOffset End)>> _held = [];

    public List<DemoMoney> Money { get; } = [];

    public Guid AdminId => Mirrors.Count > 0 ? Mirrors[0].Id : Guid.Empty;

    private TimeZoneInfo? _zone;

    /// <summary>The club's zone, looked up once — the lookup reads the zone database, and the generator asks thousands of times.</summary>
    public TimeZoneInfo Zone => _zone ??= ClubClock.ZoneOf(Settings);

    public DateOnly Today => DateOf(Now);

    /// <summary>The club-local date of an instant.</summary>
    public DateOnly DateOf(DateTimeOffset instant) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(instant, Zone).DateTime);

    /// <summary>The instant of a club-local wall time; a time inside a spring-forward gap moves on to the first that exists.</summary>
    public DateTimeOffset At(DateOnly day, int minute)
    {
        var wall = day.ToDateTime(TimeOnly.MinValue).AddMinutes(minute);
        while (Zone.IsInvalidTime(wall)) wall = wall.AddMinutes(1);
        return new DateTimeOffset(wall, Zone.GetUtcOffset(wall)).ToUniversalTime().Storable();
    }

    public bool Chance(double p) => Rng.NextDouble() < p;

    public T Pick<T>(IReadOnlyList<T> items) => items[Rng.Next(items.Count)];

    /// <summary>A random span between two bounds, in whole minutes.</summary>
    public TimeSpan Between(TimeSpan min, TimeSpan max) =>
        TimeSpan.FromMinutes(Rng.Next((int)min.TotalMinutes, (int)Math.Max(min.TotalMinutes + 1, max.TotalMinutes)));

    public bool CourtFree(Guid courtId, DateTimeOffset start, DateTimeOffset end) =>
        !_held.TryGetValue((courtId, DateOf(start)), out var spans) || spans.All(h => h.End <= start || end <= h.Start);

    public void Hold(Guid courtId, DateTimeOffset start, DateTimeOffset end)
    {
        var key = (courtId, DateOf(start));
        if (!_held.TryGetValue(key, out var spans)) _held[key] = spans = [];
        spans.Add((start, end));
    }
}
