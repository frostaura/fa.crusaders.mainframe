using System.Security.Claims;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <see cref="LiveAdminRole"/> without HTTP: what it strips, what it caches, and — the cost
/// claim — that a member's token never reaches the database.
/// </summary>
public sealed class LiveAdminRoleTests
{
    private static ClaimsPrincipal Principal(Guid userId, Guid tenantId, bool admin)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, userId.ToString()),
            new("tenant_id", tenantId.ToString()),
        };
        if (admin) claims.Add(new Claim(ClaimTypes.Role, "admin"));
        return new ClaimsPrincipal(new ClaimsIdentity(claims, "Bearer"));
    }

    /// <summary>Resolving anything from this fails the test, so reaching the database does.</summary>
    private sealed class NoServices : IServiceProvider
    {
        public object? GetService(Type serviceType) =>
            throw new InvalidOperationException($"A member's token resolved {serviceType.Name}; it must not touch the database.");
    }

    [Fact]
    public async Task A_token_that_does_not_claim_admin_is_never_looked_up()
    {
        var live = new LiveAdminRole(new MemoryCache(new MemoryCacheOptions()));
        var principal = Principal(Guid.NewGuid(), Guid.NewGuid(), admin: false);

        await live.EnforceAsync(principal, new NoServices(), CancellationToken.None);

        Assert.False(principal.IsInRole("admin"));
    }

    [Fact]
    public async Task An_admin_who_still_is_one_keeps_the_role()
    {
        await using var host = await TestHost.CreateAsync();
        var live = host.Services.GetRequiredService<LiveAdminRole>();
        var principal = Principal(host.AdminUser.Id, host.Tenant.Id, admin: true);

        using var scope = host.Services.CreateScope();
        await live.EnforceAsync(principal, scope.ServiceProvider, CancellationToken.None);

        Assert.True(principal.IsInRole("admin"));
    }

    [Fact]
    public async Task A_token_claiming_admin_for_an_account_that_is_not_one_loses_the_role()
    {
        await using var host = await TestHost.CreateAsync();
        var live = host.Services.GetRequiredService<LiveAdminRole>();
        var principal = Principal(host.PlayerUser.Id, host.Tenant.Id, admin: true);

        using var scope = host.Services.CreateScope();
        await live.EnforceAsync(principal, scope.ServiceProvider, CancellationToken.None);

        Assert.False(principal.IsInRole("admin"));
        // Only the role goes; who they are stays.
        Assert.Equal(host.PlayerUser.Id.ToString(), principal.FindFirst(ClaimTypes.NameIdentifier)?.Value);
    }

    /// <summary>
    /// The cache is real — a flip made behind its back is not seen inside the window — and the
    /// eviction is what the admin endpoint relies on to make a demotion bite at once.
    /// </summary>
    [Fact]
    public async Task A_cached_answer_stands_until_it_is_invalidated()
    {
        await using var host = await TestHost.CreateAsync();
        var live = host.Services.GetRequiredService<LiveAdminRole>();

        using (var scope = host.Services.CreateScope())
        {
            var warm = Principal(host.AdminUser.Id, host.Tenant.Id, admin: true);
            await live.EnforceAsync(warm, scope.ServiceProvider, CancellationToken.None);
            Assert.True(warm.IsInRole("admin"));

            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var admin = await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == host.AdminUser.Id);
            admin.IsAdmin = false;
            await db.SaveChangesAsync();
        }

        using (var scope = host.Services.CreateScope())
        {
            var cached = Principal(host.AdminUser.Id, host.Tenant.Id, admin: true);
            await live.EnforceAsync(cached, scope.ServiceProvider, CancellationToken.None);
            Assert.True(cached.IsInRole("admin"));

            live.Invalidate(host.Tenant.Id, host.AdminUser.Id);
            var fresh = Principal(host.AdminUser.Id, host.Tenant.Id, admin: true);
            await live.EnforceAsync(fresh, scope.ServiceProvider, CancellationToken.None);
            Assert.False(fresh.IsInRole("admin"));
        }
    }

    [Fact]
    public async Task An_admin_token_with_no_readable_tenant_loses_the_role()
    {
        await using var host = await TestHost.CreateAsync();
        var live = host.Services.GetRequiredService<LiveAdminRole>();
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, host.AdminUser.Id.ToString()), new Claim(ClaimTypes.Role, "admin")], "Bearer"));

        using var scope = host.Services.CreateScope();
        await live.EnforceAsync(principal, scope.ServiceProvider, CancellationToken.None);

        Assert.False(principal.IsInRole("admin"));
    }
}
