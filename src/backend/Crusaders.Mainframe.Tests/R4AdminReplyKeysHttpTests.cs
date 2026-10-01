using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4 wave B: keys the admin console reads that no handler sent (F3's contract audit
/// pinned them as <c>it.fails</c> in <c>lib/adminResponses.contract.test.ts</c>). The contract test
/// proves the keys exist; these prove the VALUES are the right ones.
/// </summary>
public sealed class R4AdminReplyKeysHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory Factory => pg.SharedHost;

    private async Task WithDbAsync(Func<MainframeDbContext, Task> act)
    {
        using var scope = Factory.Services.CreateScope();
        await act(scope.ServiceProvider.GetRequiredService<MainframeDbContext>());
    }

    /// <summary>
    /// One night, three rows: an offline door scan the board timed after its own upload (≈, inside
    /// the board's outage), an online one at a second door, and a top-up no board wrote.
    /// </summary>
    [SkippableFact]
    public async Task A_night_event_names_its_board_says_when_its_time_is_approximate_and_which_outage_it_fell_in()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4keytr");
        var now = DateTimeOffset.UtcNow;
        var front = await club.AddDoorAsync(Factory, "gate-front", "front");
        var side = await club.AddDoorAsync(Factory, "gate-side", "side");
        var outage = Guid.NewGuid();
        await WithDbAsync(async db =>
        {
            db.DeviceOutages.Add(new DeviceOutage
            {
                Id = outage, TenantId = club.TenantId, DeviceId = front,
                StartedAt = now.AddMinutes(-50).ToUniversalTime(), DetectedAt = now.AddMinutes(-48).ToUniversalTime(),
                EndedAt = now.AddMinutes(-20).ToUniversalTime(),
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = club.MemberUserId, Type = LedgerEntryType.TopUp,
                AmountMinutes = 10, ActorUserId = club.MemberUserId, CreatedAt = now.AddMinutes(-5).ToUniversalTime(),
            });
            await db.SaveChangesAsync();
        });

        // Delivered at -40 but claiming a scan at -30: an order that cannot have happened.
        await club.WriteRowAsync(Factory, front, "device.gate_open", now.AddMinutes(-40),
            subjectUserId: club.MemberUserId, seq: 7, deviceCode: "gate-front", occurredAt: now.AddMinutes(-30));
        await club.WriteRowAsync(Factory, side, "gate.opened", now.AddMinutes(-10),
            subjectUserId: club.MemberUserId, deviceCode: "gate-side");

        var range = $"from={Uri.EscapeDataString(now.AddHours(-2).ToString("O"))}&to={Uri.EscapeDataString(now.AddHours(1).ToString("O"))}";
        var events = (await club.AdminClient(Factory).GetFromJsonAsync<JsonElement>(
                $"/api/v1/admin/members/{club.MemberUserId}/trace?{range}"))
            .GetProperty("events").EnumerateArray().ToList();
        Assert.Equal(3, events.Count);

        var offline = events[0];
        Assert.Equal("gate-front", offline.GetProperty("device_code").GetString());
        Assert.True(offline.GetProperty("approximate").GetBoolean());
        Assert.Equal(outage, offline.GetProperty("outage_id").GetGuid());

        var online = events[1];
        Assert.Equal("gate-side", online.GetProperty("device_code").GetString());
        Assert.False(online.GetProperty("approximate").GetBoolean());
        Assert.Equal(JsonValueKind.Null, online.GetProperty("outage_id").ValueKind);

        var money = events[2];
        Assert.Equal("ledger", money.GetProperty("source").GetString());
        Assert.Equal(JsonValueKind.Null, money.GetProperty("device_code").ValueKind);
        Assert.False(money.GetProperty("approximate").GetBoolean());
    }

    /// <summary>
    /// The group's member list says who added each member and shows the face as a LINK (a group can
    /// hold the whole club; a data URI per row is the read the perf round took off every list), and
    /// its cursor is null because every member came in the one reply.
    /// </summary>
    [SkippableFact]
    public async Task A_group_member_row_names_who_added_them_with_a_photo_link_and_no_further_page()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4keygrp");
        const string Photo = "data:image/png;base64,iVBORw0KGgo=";
        await WithDbAsync(async db =>
        {
            var m = await db.Memberships.IgnoreQueryFilters().SingleAsync(x => x.UserId == club.MemberUserId);
            m.PhotoUrl = Photo;
            await db.SaveChangesAsync();
        });
        var admin = club.AdminClient(Factory);
        var created = await admin.PostAsJsonAsync("/api/v1/admin/member-groups", new { name = "Juniors" });
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        await admin.PostAsJsonAsync($"/api/v1/admin/member-groups/{id}/members", new { userIds = new[] { club.MemberUserId } });

        var body = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/member-groups/{id}/members");
        Assert.Equal(JsonValueKind.Null, body.GetProperty("cursor").ValueKind);
        var row = Assert.Single(body.GetProperty("members").EnumerateArray());
        Assert.Equal("Door Admin", row.GetProperty("added_by_name").GetString());
        var photo = row.GetProperty("photo_url").GetString()!;
        Assert.StartsWith($"/api/v1/photos/{club.MemberUserId:N}/", photo);
        Assert.Equal(System.Net.HttpStatusCode.OK, (await Factory.CreateClient().GetAsync(photo)).StatusCode);
    }

    /// <summary>A court tile carries `door`, null: no door is mapped to a court, even with a gate in the club.</summary>
    [SkippableFact]
    public async Task A_court_tile_carries_its_door_as_null_when_no_door_is_mapped_to_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r4keydoor");
        await club.AddDoorAsync(Factory, "gate-front", "front", lastSeenAt: DateTimeOffset.UtcNow);

        var board = await club.AdminClient(Factory).GetFromJsonAsync<JsonElement>("/api/v1/admin/control-board");
        var tile = Assert.Single(board.GetProperty("courts").EnumerateArray());
        Assert.True(tile.TryGetProperty("door", out var door));
        Assert.Equal(JsonValueKind.Null, door.ValueKind);
    }
}
