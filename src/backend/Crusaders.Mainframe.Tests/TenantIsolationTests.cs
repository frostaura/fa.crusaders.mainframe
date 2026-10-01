using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Cross-tenant injection tests. Every tenant-scoped table should have an assertion here.
///
/// <para>
/// <b>Every host in this file shares one database.</b> That is the whole point, and it
/// is what these tests did not do before: with a database per host, tenant B's store
/// was empty because it was a <i>different store</i>, so <c>Assert.Empty</c> held with
/// every global query filter deleted. The tests passed and proved nothing. The old
/// version's own comment conceded it — "TestHost uses unique DB names per host" — and
/// then asserted as though it did not.
/// </para>
///
/// <para>
/// The guard against that regressing is <see cref="Shared_database_really_is_shared"/>:
/// if the harness ever goes back to isolating hosts, that test fails first and says why.
/// </para>
/// </summary>
public class TenantIsolationTests
{
    /// <summary>Two hosts, one store. Named per test so tests stay independent of each other.</summary>
    private static Task<(TestHost A, TestHost B)> TwoTenantsAsync(string db) => CreateBothAsync(db);

    private static async Task<(TestHost, TestHost)> CreateBothAsync(string db)
    {
        var a = await TestHost.CreateAsync("alpha", db);
        var b = await TestHost.CreateAsync("bravo", db);
        return (a, b);
    }

    /// <summary>
    /// The meta-test. Reads across the filter to confirm both tenants' rows are
    /// genuinely in the same physical store — without which nothing else in this
    /// file is evidence of anything.
    /// </summary>
    [Fact]
    public async Task Shared_database_really_is_shared()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        using var scope = hostA.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var tenantIds = await db.Users.IgnoreQueryFilters()
            .Select(u => u.TenantId).Distinct().ToListAsync();

        Assert.Contains(hostA.Tenant.Id, tenantIds);
        Assert.Contains(hostB.Tenant.Id, tenantIds);
    }

    [Fact]
    public async Task Bookings_and_ledger_are_filtered_by_current_tenant()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        using (var scope = hostA.NewScope())
        {
            var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
            var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
            await ledger.PostAsync(new LedgerPosting(hostA.PlayerUser.Id, LedgerEntryType.TopUp, 200, hostA.PlayerUser.Id), default);
            await booking.CreateAsync(hostA.Courts[0].Id, hostA.PlayerUser.Id, hostA.PlayerUser.Id, TestHost.BookableSlot(2), 1, default);
        }

        // Tenant B is looking at the same rows tenant A just wrote. The only thing
        // between them is the global query filter.
        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db.Bookings.ToListAsync());
            Assert.Empty(await db.LedgerEntries.ToListAsync());

            // ...and they are demonstrably there, behind it.
            Assert.NotEmpty(await db.Bookings.IgnoreQueryFilters().ToListAsync());
        }

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.NotEmpty(await db.Bookings.ToListAsync());
        }
    }

    /// <summary>
    /// A balance is a sum over the ledger, so a filter leak here is not a privacy bug
    /// but a money bug: tenant B would read tenant A's credits as its own.
    /// </summary>
    [Fact]
    public async Task Balance_does_not_sum_across_tenants()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        using (var scope = hostA.NewScope())
        {
            var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
            await ledger.PostAsync(new LedgerPosting(hostA.PlayerUser.Id, LedgerEntryType.TopUp, 500, hostA.PlayerUser.Id), default);
        }

        using (var scope = hostB.NewScope())
        {
            var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

            // Asked for tenant A's user id while acting as tenant B: the id is real and
            // the rows exist, which is exactly the shape of a cross-tenant probe.
            var leaked = await ledger.GetBalanceAsync(hostA.PlayerUser.Id, default);
            Assert.Equal(0, leaked);

            var own = await ledger.GetBalanceAsync(hostB.PlayerUser.Id, default);
            Assert.Equal(0, own);
        }
    }

    [Fact]
    public async Task Memberships_are_filtered_by_current_tenant()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var memberships = await db.Memberships.ToListAsync();
            Assert.NotEmpty(memberships);
            Assert.All(memberships, m => Assert.Equal(hostA.Tenant.Id, m.TenantId));
        }

        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var memberships = await db.Memberships.ToListAsync();
            Assert.NotEmpty(memberships);
            Assert.All(memberships, m => Assert.Equal(hostB.Tenant.Id, m.TenantId));
        }
    }

    /// <summary>
    /// Devices are the newest tenant-scoped table and the one with teeth: a device row
    /// visible across tenants is a relay in another club's building.
    /// </summary>
    [Fact]
    public async Task Devices_are_filtered_by_current_tenant()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        Guid deviceId;
        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = new Device
            {
                TenantId = hostA.Tenant.Id,
                DeviceCode = "court-box-1",
                Name = "Court 1 box",
                Kind = DeviceKind.CourtBox,
                Hardware = DeviceHardware.Esp8266,
                MacAddress = "1a0000000001",
                CourtNumbers = [1],
            };
            db.Devices.Add(device);
            await db.SaveChangesAsync();
            deviceId = device.Id;
        }

        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db.Devices.ToListAsync());
            Assert.Null(await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId));
            Assert.NotNull(await db.Devices.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.Id == deviceId));
        }

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.NotNull(await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId));
        }
    }

    /// <summary>
    /// The same device code in two clubs must be legal — "court-box-1" is the obvious
    /// name and every tenant will pick it. Uniqueness is scoped to the tenant, and
    /// resolution must still land on the right row.
    /// </summary>
    [Fact]
    public async Task Same_device_code_in_two_tenants_resolves_independently()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        async Task<Guid> AddAsync(TestHost host)
        {
            using var scope = host.NewScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var d = new Device
            {
                TenantId = host.Tenant.Id,
                DeviceCode = "court-box-1",
                Name = "Court 1 box",
                MacAddress = Guid.NewGuid().ToString("N")[..12],
                CourtNumbers = [1],
            };
            db.Devices.Add(d);
            await db.SaveChangesAsync();
            return d.Id;
        }

        var idA = await AddAsync(hostA);
        var idB = await AddAsync(hostB);
        Assert.NotEqual(idA, idB);

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var found = await db.Devices.SingleAsync(d => d.DeviceCode == "court-box-1");
            Assert.Equal(idA, found.Id);
        }

        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var found = await db.Devices.SingleAsync(d => d.DeviceCode == "court-box-1");
            Assert.Equal(idB, found.Id);
        }
    }

    /// <summary>
    /// Device event receipts — the newest tenant-scoped table.
    ///
    /// <para>
    /// It exists to answer "have I already recorded this box's event number 7?", and its
    /// unique index is on <c>(TenantId, DeviceId, Seq)</c>. Two clubs' boxes both start at
    /// sequence 1, so a leak here does not merely expose a row — it would make one club's
    /// upload look like a duplicate of another's and be <b>silently discarded</b>, which is
    /// a court that was used and never charged for.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Device_event_receipts_are_filtered_by_current_tenant()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        var deviceId = Guid.NewGuid();

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = hostA.Tenant.Id,
                DeviceId = deviceId,
                Seq = 1,
                Kind = "activation",
                OccurredAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db.DeviceEventReceipts.ToListAsync());
            // ...and it is demonstrably there, behind the filter.
            Assert.NotEmpty(await db.DeviceEventReceipts.IgnoreQueryFilters().ToListAsync());

            // The consequence spelled out: tenant B's box may use sequence 1 too, and that
            // must be a new event rather than a duplicate of tenant A's.
            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = hostB.Tenant.Id,
                DeviceId = deviceId,
                Seq = 1,
                Kind = "activation",
                OccurredAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
            Assert.Single(await db.DeviceEventReceipts.ToListAsync());
        }

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Single(await db.DeviceEventReceipts.ToListAsync());
        }
    }

    /// <summary>
    /// Courts and tenant settings: the two tables a court box reads on every heartbeat.
    /// A leak here misprices another club's court.
    /// </summary>
    [Fact]
    public async Task Courts_and_settings_are_filtered_by_current_tenant()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"shared-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        using var scope = hostB.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var courts = await db.Courts.ToListAsync();
        Assert.All(courts, c => Assert.Equal(hostB.Tenant.Id, c.TenantId));
        Assert.DoesNotContain(courts, c => c.Id == hostA.Courts[0].Id);

        var settings = await db.TenantSettings.ToListAsync();
        Assert.All(settings, s => Assert.Equal(hostB.Tenant.Id, s.TenantId));
    }

    /// <summary>
    /// The three member-group tables (GOAL item 3) — the repo's non-negotiable cross-tenant
    /// injection test, applied to every one of them.
    ///
    /// <para>
    /// It matters more here than for most tables, because these rows decide what a member may
    /// book and WHAT THEY PAY. A group leaking across the filter is not a privacy problem, it is
    /// another club's tariff applied to this club's members.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Member_groups_and_their_windows_and_members_are_filtered_by_current_tenant()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"groups-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        Guid groupInA;
        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var group = new MemberGroup
            {
                TenantId = hostA.Tenant.Id,
                Name = "Alpha league",
                PackageDiscountBps = 5_000,
            };
            db.MemberGroups.Add(group);
            db.MemberGroupWindows.Add(new MemberGroupWindow
            {
                TenantId = hostA.Tenant.Id, GroupId = group.Id,
                DayOfWeek = DayOfWeek.Tuesday, StartMinute = 60, EndMinute = 120,
            });
            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = hostA.Tenant.Id, GroupId = group.Id, UserId = hostA.PlayerUser.Id,
            });
            await db.SaveChangesAsync();
            groupInA = group.Id;
        }

        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            Assert.DoesNotContain(await db.MemberGroups.ToListAsync(), g => g.Id == groupInA);
            Assert.DoesNotContain(await db.MemberGroupWindows.ToListAsync(), w => w.GroupId == groupInA);
            Assert.DoesNotContain(await db.MemberGroupMembers.ToListAsync(), m => m.GroupId == groupInA);

            // Naming the id directly, which is what an injected parameter would do.
            Assert.Null(await db.MemberGroups.FirstOrDefaultAsync(g => g.Id == groupInA));
        }
    }

    /// <summary>
    /// And the RULES the other club's group would impose do not reach this club's member: the
    /// evaluator reads groups through the same filter, so a five-times multiplier next door is
    /// not a price here.
    /// </summary>
    [Fact]
    public async Task Another_clubs_group_does_not_price_this_clubs_member()
    {
        var (hostA, hostB) = await TwoTenantsAsync($"grouprules-{Guid.NewGuid():N}");
        await using var a = hostA;
        await using var b = hostB;

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var group = new MemberGroup
            {
                TenantId = hostA.Tenant.Id,
                Name = "Alpha premium",
                PackageDiscountBps = 9_000,
            };
            db.MemberGroups.Add(group);
            // The same USER id in the other club's membership row — the shape an injected id
            // takes when two clubs' tables share a store.
            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = hostA.Tenant.Id, GroupId = group.Id, UserId = hostB.PlayerUser.Id,
            });
            await db.SaveChangesAsync();
        }

        using (var scope = hostB.NewScope())
        {
            var rules = scope.ServiceProvider.GetRequiredService<BookingRules>();
            var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

            var groups = await rules.GroupsForAsync(hostB.PlayerUser.Id, DayOfWeek.Tuesday, settings, default);

            Assert.Empty(groups);
            // P13: groups no longer price a booking; the other club's discount must not reach here either.
            var tariff = await MemberTariffs.ForAsync(
                scope.ServiceProvider.GetRequiredService<MainframeDbContext>(), hostB.PlayerUser.Id, settings, default);
            Assert.Null(tariff.PackageDiscountBps);
        }
    }
}
