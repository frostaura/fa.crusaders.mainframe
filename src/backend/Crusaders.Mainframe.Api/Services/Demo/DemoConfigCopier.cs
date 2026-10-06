using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// The demo club's starting configuration: a COPY of the real club's settings, courts, groups
/// (with their booking windows) and minute packages, so the demo looks like the club the admin
/// runs. The real club's rows are only read here, never written.
///
/// <para>
/// <b>What is not copied.</b> The payment credentials (<c>payfast</c>) — a demo club takes no
/// money, and a purchase there completes as a simulation (<see cref="DemoPurchase"/>) — and any
/// mail server settings. The device key is a column on the club row and is never copied either.
/// </para>
/// </summary>
public static class DemoConfigCopier
{
    /// <summary>Settings keys that hold another system's credentials and stay with the real club.</summary>
    private static readonly string[] NotCopied = ["payfast", "smtp"];

    /// <summary>Copies everything into the demo club; answers the old-group-id → new-group-id map.</summary>
    public static async Task<Dictionary<Guid, Guid>> CopyAsync(
        MainframeDbContext db, Guid sourceTenantId, Guid demoTenantId, Guid actorUserId, CancellationToken ct)
    {
        await CopySettingsAsync(db, sourceTenantId, demoTenantId, ct);
        await CopyCourtsAsync(db, sourceTenantId, demoTenantId, ct);
        var groups = await CopyGroupsAsync(db, sourceTenantId, demoTenantId, actorUserId, ct);
        await CopyPackagesAsync(db, sourceTenantId, demoTenantId, groups, actorUserId, ct);
        await db.SaveChangesAsync(ct);

        // A real club that has never configured these still gets a demo that shows them.
        await MemberGroupSeeder.EnsureAsync(db, demoTenantId, ct);
        await MinutePackageSeeder.EnsureAsync(db, demoTenantId, actorUserId, ct);
        return groups;
    }

    private static async Task CopySettingsAsync(MainframeDbContext db, Guid source, Guid demo, CancellationToken ct)
    {
        var json = await db.TenantSettings.IgnoreQueryFilters().AsNoTracking()
            .Where(s => s.TenantId == source).Select(s => s.SettingsJson).FirstOrDefaultAsync(ct) ?? "{}";
        var node = JsonNode.Parse(json) as JsonObject ?? [];
        foreach (var key in NotCopied) node.Remove(key);
        db.TenantSettings.Add(new TenantSettings { TenantId = demo, SettingsJson = node.ToJsonString() });
    }

    private static async Task CopyCourtsAsync(MainframeDbContext db, Guid source, Guid demo, CancellationToken ct)
    {
        var courts = await db.Courts.IgnoreQueryFilters().AsNoTracking()
            .Where(c => c.TenantId == source).OrderBy(c => c.CourtNumber).ToListAsync(ct);
        if (courts.Count == 0)
        {
            // A club with no courts yet still deserves a demo with some.
            courts = Enumerable.Range(1, 4).Select(n => new Court { TenantId = source, CourtNumber = n, Name = $"Court {n}" }).ToList();
        }
        foreach (var c in courts)
        {
            db.Courts.Add(new Court
            {
                TenantId = demo,
                CourtNumber = c.CourtNumber,
                Name = c.Name,
                CourtType = c.CourtType,
                IsActive = c.IsActive,
            });
        }
    }

    private static async Task<Dictionary<Guid, Guid>> CopyGroupsAsync(
        MainframeDbContext db, Guid source, Guid demo, Guid actor, CancellationToken ct)
    {
        var groups = await db.MemberGroups.IgnoreQueryFilters().AsNoTracking()
            .Where(g => g.TenantId == source && g.Status == MemberGroupStatus.Active).ToListAsync(ct);
        var windows = await db.MemberGroupWindows.IgnoreQueryFilters().AsNoTracking()
            .Where(w => w.TenantId == source).ToListAsync(ct);
        var map = new Dictionary<Guid, Guid>();
        foreach (var g in groups)
        {
            var copy = new MemberGroup
            {
                TenantId = demo,
                Name = g.Name,
                Description = g.Description,
                SortOrder = g.SortOrder,
                MaxSlotsPerDay = g.MaxSlotsPerDay,
                MaxMinutesPerDay = g.MaxMinutesPerDay,
                AdvanceBookingDays = g.AdvanceBookingDays,
                PackageDiscountBps = g.PackageDiscountBps,
                PeakPriority = g.PeakPriority,
                SystemKey = g.SystemKey,
                IsSystemDefault = g.IsSystemDefault,
                CreatedByUserId = actor,
            };
            db.MemberGroups.Add(copy);
            map[g.Id] = copy.Id;
        }
        foreach (var w in windows.Where(w => map.ContainsKey(w.GroupId)))
        {
            db.MemberGroupWindows.Add(new MemberGroupWindow
            {
                TenantId = demo,
                GroupId = map[w.GroupId],
                DayOfWeek = w.DayOfWeek,
                StartMinute = w.StartMinute,
                EndMinute = w.EndMinute,
            });
        }
        return map;
    }

    private static async Task CopyPackagesAsync(
        MainframeDbContext db, Guid source, Guid demo, Dictionary<Guid, Guid> groups, Guid actor, CancellationToken ct)
    {
        var packages = await db.MinutePackages.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.TenantId == source && p.Status == MinutePackageStatus.Active).ToListAsync(ct);
        foreach (var p in packages.Where(p => p.GroupId is null || groups.ContainsKey(p.GroupId.Value)))
        {
            db.MinutePackages.Add(new MinutePackage
            {
                TenantId = demo,
                GroupId = p.GroupId is { } g ? groups[g] : null,
                Name = p.Name,
                Minutes = p.Minutes,
                PriceZar = p.PriceZar,
                SortOrder = p.SortOrder,
                CreatedByUserId = actor,
            });
        }
    }
}
