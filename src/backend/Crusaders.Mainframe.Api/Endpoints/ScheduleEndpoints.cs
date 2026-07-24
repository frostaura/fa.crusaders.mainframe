using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class ScheduleEndpoints
{
    public static IEndpointRouteBuilder MapScheduleEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1").RequireAuthorization();

        g.MapGet("/schedule", async (DateOnly? date, HttpContext ctx, ScheduleService schedule, CancellationToken ct) =>
        {
            var d = date ?? DateOnly.FromDateTime(DateTime.UtcNow);
            var day = await schedule.GetDayAsync(d, ctx.User.Id(), ct);
            return Results.Ok(day);
        });

        return app;
    }
}
