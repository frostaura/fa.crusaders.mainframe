using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class ScheduleEndpoints
{
    public static IEndpointRouteBuilder MapScheduleEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1").RequireAuthorization();

        g.MapGet("/schedule", async (
            DateOnly? date,
            string? photos,
            HttpContext ctx,
            ScheduleService schedule,
            TenantSettingsAccessor settings,
            CancellationToken ct) =>
        {
            // D2-B33. This defaulted to `DateOnly.FromDateTime(DateTime.UtcNow)` — a UTC date —
            // and ScheduleService then read it as a CLUB date. At 00:30 SAST a caller who omitted
            // the parameter was handed YESTERDAY'S grid: every slot in the past, nothing
            // bookable, and no error anywhere. Every real club is outside UTC.
            var d = date ?? ClubClock.Today(await settings.GetAsync(ct));
            var day = await schedule.GetDayAsync(d, ctx.User.Id(), ctx.User.IsInRole("admin"), ct);
            // Perf round: `photos=url` hands a stored data-URI photo out as a link (PhotoEndpoints)
            // instead of repeating it in every slot the member holds. Absent, nothing changes.
            if (!PhotoEndpoints.Wanted(photos)) return Results.Ok(day);
            return Results.Ok(day with
            {
                Slots = day.Slots.ConvertAll(s => s.OwnerUserId is { } owner
                    ? s with { OwnerPhotoUrl = PhotoEndpoints.Link(owner, s.OwnerPhotoUrl) }
                    : s),
            });
        });

        return app;
    }
}
