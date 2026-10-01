using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4 wave B: the admin actions the change-record vocabulary named and nothing wrote
/// — courts, devices, the club key, the doors, court blocks and fault resolves. Each is now
/// recorded in the action's own save; an action that changed nothing (a refused block, a lift of
/// a block already gone, an unchanged edit, a fault already resolved) records nothing.
/// </summary>
public sealed class R4ChangeRecordWritersHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory Factory => pg.SharedHost;

    private async Task<List<AdminChangeLog>> RowsAsync(Guid tenantId, string action)
    {
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(r => r.TenantId == tenantId && r.Action == action)
            .OrderBy(r => r.OccurredAt).ToListAsync();
    }

    private static Dictionary<string, (string? Before, string? After)> Diff(AdminChangeLog row)
        => AdminChangeDiff.Of(row.BeforeJson, row.AfterJson).ToDictionary(f => f.Field, f => (f.Before, f.After));

    private static string? After(AdminChangeLog row, string key)
        => row.AfterJson is { } json && JsonDocument.Parse(json).RootElement.TryGetProperty(key, out var v) ? v.ToString() : null;

    [SkippableFact]
    public async Task Adding_changing_and_deactivating_a_court_is_on_the_record()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4cwcourt");
        var other = await DoorClub.SeedAsync(Factory, "r4cwcourtx");
        var admin = club.AdminClient(Factory);

        var made = await admin.PostAsJsonAsync("/api/v1/admin/courts", new { name = "Court 2", courtType = "squash", slicePriceCredits = 9 });
        Assert.Equal(HttpStatusCode.OK, made.StatusCode);
        var id = (await made.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var created = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.CourtCreated));
        Assert.Equal((AdminChangeSubjects.Court, id, "Court 2", club.AdminUserId), (created.SubjectKind, created.SubjectId!.Value, created.SubjectLabel, created.ActorUserId));
        Assert.Equal("Court 2", After(created, "name"));
        Assert.Equal("9", After(created, "slice_price_credits"));

        Assert.Equal(HttpStatusCode.OK, (await admin.PatchAsJsonAsync($"/api/v1/admin/courts/{id}", new { name = "Glass court", slicePriceCredits = 9 })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PatchAsJsonAsync($"/api/v1/admin/courts/{id}", new { name = "Glass court" })).StatusCode);
        var updated = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.CourtUpdated));
        Assert.Equal(new Dictionary<string, (string?, string?)> { ["name"] = ("Court 2", "Glass court") }, Diff(updated));

        Assert.Equal(HttpStatusCode.OK, (await admin.PatchAsJsonAsync($"/api/v1/admin/courts/{id}", new { isActive = false })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.DeleteAsync($"/api/v1/admin/courts/{id}")).StatusCode);
        var gone = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.CourtDeactivated));
        Assert.Equal(("yes", "no"), Diff(gone)["is_active"]);

        Assert.Equal(HttpStatusCode.OK, (await admin.DeleteAsync($"/api/v1/admin/courts/{club.CourtId}")).StatusCode);
        Assert.Equal(2, (await RowsAsync(club.TenantId, AdminChangeActions.CourtDeactivated)).Count);

        Assert.Empty(await RowsAsync(other.TenantId, AdminChangeActions.CourtDeactivated));
    }

    [SkippableFact]
    public async Task Editing_and_removing_a_board_and_rotating_the_club_key_are_on_the_record()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4cwdev");
        var admin = club.AdminClient(Factory);
        var box = await club.AddCourtBoxAsync(Factory, "box-a1");

        Assert.Equal(HttpStatusCode.OK, (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{box}", new { name = "Court 1 box", enabled = false })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{box}", new { name = "Court 1 box" })).StatusCode);
        var edit = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.DeviceUpdated));
        Assert.Equal((AdminChangeSubjects.Device, box), (edit.SubjectKind, edit.SubjectId!.Value));
        Assert.Contains("box-a1", edit.SubjectLabel);
        var diff = Diff(edit);
        Assert.Equal(("Court box", "Court 1 box"), diff["name"]);
        Assert.Equal(("yes", "no"), diff["in_service"]);

        Assert.Equal(HttpStatusCode.OK, (await admin.DeleteAsync($"/api/v1/admin/devices/{box}")).StatusCode);
        var removed = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.DeviceDeleted));
        Assert.Equal("box-a1", Diff(removed)["device_code"].Before);
        Assert.Null(removed.AfterJson);

        var key = (await (await admin.PostAsync("/api/v1/admin/devices/api-key/regenerate", null)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("api_key").GetString()!;
        var rotated = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.DeviceApiKeyRegenerated));
        Assert.DoesNotContain(key, (rotated.BeforeJson ?? "") + (rotated.AfterJson ?? ""));
        Assert.DoesNotContain(club.DeviceKey, (rotated.BeforeJson ?? "") + (rotated.AfterJson ?? ""));
    }

    [SkippableFact]
    public async Task Shutting_and_reopening_every_door_is_on_the_record_with_the_doors_named()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4cwdoor");
        var admin = club.AdminClient(Factory);
        await club.AddDoorAsync(Factory, "gate-f", "front", name: "Front door");
        await club.AddDoorAsync(Factory, "gate-s", "side", name: "Side door");

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync("/api/v1/admin/doors/shut-all", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync("/api/v1/admin/doors/reopen-all", null)).StatusCode);

        var shut = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.DoorsShutAll));
        Assert.Equal("2", After(shut, "doors"));
        Assert.Equal("Front door, Side door", Diff(shut)["door_names"].After);
        var reopened = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.DoorsReopenedAll));
        Assert.Equal("2", After(reopened, "doors"));
    }

    [SkippableFact]
    public async Task Blocking_a_court_and_lifting_the_block_are_on_the_record_and_a_refusal_is_not()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4cwblock");
        var admin = club.AdminClient(Factory);
        var at = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(2).AddHours(10), TimeSpan.Zero);
        var body = new { courtId = club.CourtId, startsAt = at, sliceCount = 2, label = "Coaching" };

        var made = await admin.PostAsJsonAsync("/api/v1/admin/blocks", body);
        Assert.True(made.IsSuccessStatusCode, await made.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/api/v1/admin/blocks", body)).StatusCode);
        var blocked = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.BookingBlocked));
        Assert.Equal((AdminChangeSubjects.Court, club.CourtId, "Court 1"), (blocked.SubjectKind, blocked.SubjectId!.Value, blocked.SubjectLabel));
        Assert.Equal("Coaching", After(blocked, "label"));
        Assert.Equal(at, DateTimeOffset.Parse(After(blocked, "starts_at")!));

        Guid blockId;
        using (var scope = Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            blockId = await db.Bookings.IgnoreQueryFilters()
                .Where(b => b.TenantId == club.TenantId && b.Status == BookingStatus.AdminBlock).Select(b => b.Id).SingleAsync();
        }
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/v1/admin/blocks/{blockId}?reason=Coaching%20moved")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync($"/api/v1/admin/blocks/{blockId}?reason=Coaching%20moved")).StatusCode);
        var lifted = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.BookingBlockLifted));
        Assert.Equal("Coaching", Diff(lifted)["label"].Before);
        Assert.Null(lifted.AfterJson);
    }

    [SkippableFact]
    public async Task Resolving_a_fault_one_at_a_time_or_in_a_list_is_on_the_record_once_per_fault()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4cwfault");
        var admin = club.AdminClient(Factory);
        var box = await club.AddCourtBoxAsync(Factory, "box-f1");
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        using (var scope = Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            foreach (var id in new[] { first, second })
            {
                db.DeviceErrors.Add(new DeviceError
                {
                    Id = id, TenantId = club.TenantId, DeviceId = box, Code = "relay_stuck", Fingerprint = $"fp-{id:N}",
                    Severity = DeviceErrorSeverity.Error, Source = DeviceErrorSource.Device,
                    FirstSeenAt = DateTimeOffset.UtcNow, LastSeenAt = DateTimeOffset.UtcNow,
                });
            }
            await db.SaveChangesAsync();
        }

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/monitoring/errors/{first}/resolve", new { note = "Reseated the relay" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/v1/admin/monitoring/errors/resolve-bulk", new { ids = new[] { second, first }, note = "Swept" })).StatusCode);

        var rows = await RowsAsync(club.TenantId, AdminChangeActions.MonitoringErrorResolved);
        Assert.Equal(2, rows.Count);
        Assert.Equal(("Reseated the relay", "Swept"), (rows[0].Reason, rows[1].Reason));
        Assert.All(rows, r => Assert.Equal((AdminChangeSubjects.Device, box), (r.SubjectKind, r.SubjectId!.Value)));
        Assert.All(rows, r => Assert.Contains("box-f1", r.SubjectLabel));
        Assert.Equal("relay_stuck", After(rows[0], "code"));
    }
}
