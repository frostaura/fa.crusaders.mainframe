using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The refresh-token chain (review round 1, B1). A partial of the same class so the query
/// filter references this context's own tenant field (see <c>MainframeDbContext.Players</c>).
/// </summary>
public partial class MainframeDbContext
{
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    private void ConfigureSessions(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<RefreshToken>(e =>
        {
            e.ToTable("refresh_tokens");
            e.HasKey(t => t.Id);
            e.Property(t => t.TokenHash).HasMaxLength(RefreshToken.TokenHashMaxLength).IsRequired();
            // The cookie is looked up by its hash alone, before the tenant is compared — unique
            // so a lookup can never pick between two rows.
            e.HasIndex(t => t.TokenHash).IsUnique();
            e.HasIndex(t => new { t.TenantId, t.FamilyId });
            e.HasIndex(t => new { t.TenantId, t.UserId }).HasFilter("\"RevokedAt\" IS NULL");
            e.HasIndex(t => t.ExpiresAt);
            e.HasQueryFilter(t => t.TenantId == _tenant.TenantId);
        });
    }
}
