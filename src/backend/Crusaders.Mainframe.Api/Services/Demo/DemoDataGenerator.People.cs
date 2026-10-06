using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>How many of the made-up members are not (or no longer) playing.</summary>
    private const int Pending = 3;
    private const int Suspended = 2;
    private const int Rejected = 1;

    /// <summary>A made-up member and the membership state they were drawn into.</summary>
    private sealed record DemoMember(User User, Membership Membership);

    /// <summary>
    /// The club's people: <paramref name="count"/> made-up members — most active, a few applications
    /// waiting, a couple suspended, one turned down — plus the mirror admins, who play too. Each
    /// active one gets a group (about a third in the league), a circle of regular partners, a
    /// habit (early bird or after work) and an appetite for court time.
    /// </summary>
    private List<DemoMember> PlanPeople(DemoWorld w, int count)
    {
        var taken = w.Mirrors.Select(m => m.Email).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var names = DemoNames.Draw(w.Rng, count, taken);
        var members = new List<DemoMember>();
        for (var i = 0; i < names.Count; i++)
        {
            var status = i < Pending ? MembershipStatus.PendingApproval
                : i < Pending + Suspended ? MembershipStatus.Suspended
                : i < Pending + Suspended + Rejected ? MembershipStatus.Rejected
                : MembershipStatus.Active;
            members.Add(AddMember(w, names[i], i, status));
        }

        foreach (var mirror in w.Mirrors)
        {
            w.Players.Add(new DemoPerson
            {
                UserId = mirror.Id,
                Name = mirror.Email,
                JoinedAt = w.Now.AddDays(-400),
                Weight = 1.3,
                IsMirror = true,
            });
        }
        AssignGroups(w);
        DrawFriends(w);
        return members;
    }

    private DemoMember AddMember(DemoWorld w, string name, int index, MembershipStatus status)
    {
        var joined = status == MembershipStatus.PendingApproval
            ? w.Now - w.Between(TimeSpan.FromHours(3), TimeSpan.FromDays(4))
            : w.Now - w.Between(TimeSpan.FromDays(20), TimeSpan.FromDays(720));
        joined = joined.Storable();
        var user = new User
        {
            TenantId = w.TenantId,
            Email = DemoNames.EmailFor(name, index + 1),
            EmailVerified = true,
            Status = status == MembershipStatus.Suspended ? "suspended" : "active",
            CreatedAt = joined,
            LastLoginAt = status == MembershipStatus.Active ? (w.Now - w.Between(TimeSpan.FromMinutes(5), TimeSpan.FromDays(9))).Storable() : null,
        };
        var decided = status is MembershipStatus.PendingApproval ? (DateTimeOffset?)null : (joined + w.Between(TimeSpan.FromHours(2), TimeSpan.FromDays(2))).Storable();
        var membership = new Membership
        {
            TenantId = w.TenantId,
            UserId = user.Id,
            FullName = name,
            MembershipNumber = $"D{1001 + index}",
            PhotoUrl = DemoNames.Avatar(name, index),
            Status = status,
            RejectionReason = status == MembershipStatus.Rejected ? "We could not confirm this membership number." : null,
            ReviewedByUserId = decided is null ? null : w.AdminId,
            ReviewedAt = decided,
            CreatedAt = joined,
        };
        _db.Users.Add(user);
        _db.Memberships.Add(membership);
        _db.UserPreferences.Add(new UserPreferences
        {
            TenantId = w.TenantId,
            UserId = user.Id,
            Findable = w.Chance(0.85),
            ShowInLeaderboards = w.Chance(0.6),
            ShareResults = w.Chance(0.5),
            WeeklyRecap = w.Chance(0.3),
            MemberOnboardingCompletedAt = status == MembershipStatus.Active ? decided : null,
            UpdatedAt = joined,
        });

        if (status == MembershipStatus.Active)
        {
            // An appetite with a long tail: most play now and then, a few live at the club.
            var appetite = 0.25 + Math.Pow(w.Rng.NextDouble(), 2) * 3.2;
            w.Players.Add(new DemoPerson
            {
                UserId = user.Id,
                Name = name,
                JoinedAt = decided ?? joined,
                Weight = appetite,
                EarlyBird = w.Chance(0.22),
            });
        }
        return new DemoMember(user, membership);
    }

    /// <summary>About a third in the league group; some of the rest in one of the club's other groups.</summary>
    private void AssignGroups(DemoWorld w)
    {
        var league = w.Groups.FirstOrDefault(g => g.SystemKey == MemberGroupSystemKeys.League);
        var others = w.Groups.Where(g => g.SystemKey != MemberGroupSystemKeys.League).ToList();
        foreach (var p in w.Players)
        {
            MemberGroup? group = null;
            if (league is not null && (p.IsMirror || w.Chance(0.34))) group = league;
            else if (others.Count > 0 && w.Chance(0.4)) group = w.Pick(others);
            if (group is null) continue;
            p.GroupId = group.Id;
            _db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = w.TenantId,
                GroupId = group.Id,
                UserId = p.UserId,
                AddedByUserId = w.AdminId,
                AddedAt = p.JoinedAt.AddDays(1).Storable(),
            });
        }
    }

    /// <summary>Everyone plays with a circle of three to seven regulars; circles overlap, as they do.</summary>
    private static void DrawFriends(DemoWorld w)
    {
        foreach (var p in w.Players)
        {
            var want = w.Rng.Next(3, 8);
            var guard = 0;
            while (p.Friends.Count < want && guard++ < 40)
            {
                var other = w.Pick(w.Players);
                if (other == p || p.Friends.Contains(other)) continue;
                p.Friends.Add(other);
                if (!other.Friends.Contains(p)) other.Friends.Add(p);
            }
        }
    }
}
