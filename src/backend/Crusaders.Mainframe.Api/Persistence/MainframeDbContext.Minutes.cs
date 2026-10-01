using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The minutes packages (P13, minutes as the unit of account). A partial of the same class so the query
/// filter references this context's own tenant field (see <c>MainframeDbContext.Players</c>).
/// </summary>
public partial class MainframeDbContext
{
    /// <summary>The minutes packages members buy. See <see cref="MinutePackage"/>.</summary>
    public DbSet<MinutePackage> MinutePackages => Set<MinutePackage>();

    private void ConfigureMinutePackages(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<MinutePackage>(e =>
        {
            e.ToTable("minute_packages", t =>
            {
                t.HasCheckConstraint(
                    "ck_minute_packages_minutes",
                    $"\"Minutes\" BETWEEN {MinutePackage.MinMinutes} AND {MinutePackage.MaxMinutes}");
                t.HasCheckConstraint("ck_minute_packages_price", "\"PriceZar\" > 0 AND \"PriceZar\" <= 100000");
                t.HasCheckConstraint("ck_minute_packages_status", "\"Status\" IN (0, 1)");
            });
            e.HasKey(p => p.Id);
            e.Property(p => p.Name).HasMaxLength(MinutePackage.NameMaxLength).IsRequired();
            e.Property(p => p.PriceZar).HasColumnType("numeric(10,2)");
            e.Property(p => p.SortOrder).HasDefaultValue(0);
            e.Property(p => p.Status).HasConversion<int>().HasDefaultValue(MinutePackageStatus.Active);
            // A package is never deleted, and neither may its group be while a package names it:
            // the shelf rule would otherwise lose a package's audience silently.
            e.HasOne<MemberGroup>().WithMany().HasForeignKey(p => p.GroupId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(p => new { p.TenantId, p.Status });
            e.HasIndex(p => new { p.TenantId, p.GroupId });
            // One ACTIVE package of a name per shelf; the club shelf (null group) is a shelf too,
            // hence NULLS NOT DISTINCT. Archived names are free to be reused.
            e.HasIndex(p => new { p.TenantId, p.GroupId, p.Name })
                .IsUnique()
                .AreNullsDistinct(false)
                .HasFilter("\"Status\" = 0");
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });
    }
}
