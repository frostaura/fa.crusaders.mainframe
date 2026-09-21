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
            return Results.Ok(day);
        });

        return app;
    }
}
