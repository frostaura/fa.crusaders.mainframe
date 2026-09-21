using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>One date of a schedule, skipped or re-timed.</summary>
public sealed record ScheduleOccurrenceRequest(
    bool Skip = false, string? Start = null, string? End = null, string? Reason = null);

/// <summary>Ending a series. <c>effectiveFrom</c> is clamped to never be earlier than the club's today.</summary>
public sealed record ScheduleEndRequest(DateOnly? EffectiveFrom = null, string? Reason = null);

/// <summary>A this-and-future edit.</summary>
public sealed record ScheduleUpdateRequest(
    string? Name, string? Label, IReadOnlyList<string>? Days, string? Start, string? End,
    DateOnly? StartDate, DateOnly? EndDate, short IntervalWeeks = 1,
    IReadOnlyList<Guid>? Courts = null, DateOnly? EffectiveFrom = null, string? Reason = null)
{
    public ScheduleRequest AsRequest()
        => new(Name, Label, Days, Start, End, StartDate, EndDate, IntervalWeeks, Courts);
}


/// <summary>
/// Everything a schedule handler resolves from the container, bound as one parameter.
///
/// <para>
/// <b>Not tidiness — the complexity gate caps a signature at six arguments</b>
/// (<c>lizard -a 6</c> in the Makefile), and a schedule write genuinely needs the context, the
/// settings, the service, the recorder and the tenant alongside its request body and its
/// cancellation token. <c>[AsParameters]</c> is the framework's own answer to that, and it
/// keeps the alternative — resolving services out of <c>HttpContext.RequestServices</c> by
/// hand — out of the handlers, where it would hide the dependencies from the DI graph.
/// </para>
/// </summary>
public sealed record ScheduleDeps(
    MainframeDbContext Db,
    TenantSettingsAccessor Settings,
    BookingScheduleService Schedules,
    AdminChangeRecorder Recorder,
    ITenantContext Tenant);
