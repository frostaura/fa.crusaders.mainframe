using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The two pure pieces of R20: where an account's admin rights are said to come from, and the
/// key the last-admin guard locks on.
/// </summary>
public sealed class AdminRoleUnitTests
{
    [Theory]
    [InlineData(true, "a@x.test", "config")]
    [InlineData(true, "b@x.test", "granted")]
    [InlineData(false, "a@x.test", null)]
    [InlineData(false, "b@x.test", null)]
    public void The_admin_source_says_where_the_rights_came_from(bool isAdmin, string email, string? expected)
    {
        var inherent = new InherentAdmins(new HashSet<string> { "a@x.test" }, []);
        Assert.Equal(expected, AdminSource.Of(isAdmin, email, inherent));
    }

    [Fact]
    public void The_admin_lock_key_is_stable_per_club_and_distinct_between_clubs_and_from_payer_locks()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();

        Assert.Equal(AdminRoleService.LockKey(a), AdminRoleService.LockKey(a));
        Assert.NotEqual(AdminRoleService.LockKey(a), AdminRoleService.LockKey(b));
        Assert.NotEqual(AdminRoleService.LockKey(a), PayerLock.KeyFor(a, Guid.Empty));
    }
}
