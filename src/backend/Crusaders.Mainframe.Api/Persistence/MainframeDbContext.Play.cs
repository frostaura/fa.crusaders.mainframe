using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The play tables (D14, <c>docs/specs/play.md</c> §2), in a partial of their own for the 200-line
/// reason and in the SAME class, because a query filter must reference this context's own tenant
/// field for EF to parameterise it per instance (see <c>MainframeDbContext.Players</c>).
/// </summary>
public partial class MainframeDbContext
{
    public DbSet<MatchResult> MatchResults => Set<MatchResult>();
    public DbSet<MatchResultPlayer> MatchResultPlayers => Set<MatchResultPlayer>();
    public DbSet<MemberBadge> MemberBadges => Set<MemberBadge>();
    public DbSet<PlayCelebration> PlayCelebrations => Set<PlayCelebration>();
    public DbSet<MemberPlayProfile> MemberPlayProfiles => Set<MemberPlayProfile>();
    public DbSet<MemberStreakPause> MemberStreakPauses => Set<MemberStreakPause>();

    private void ConfigurePlay(ModelBuilder modelBuilder)
    {
        ConfigureMatchResults(modelBuilder);

        modelBuilder.Entity<MemberBadge>(e =>
        {
            e.ToTable("member_badges");
            e.HasKey(b => b.Id);
            e.Property(b => b.BadgeKey).HasMaxLength(MemberBadge.BadgeKeyMaxLength).IsRequired();
            // Awarding is INSERT … ON CONFLICT DO NOTHING against this index: idempotent however
            // often, or however concurrently, the evaluator runs.
            e.HasIndex(b => new { b.TenantId, b.UserId, b.BadgeKey }).IsUnique();
            e.HasQueryFilter(b => b.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<PlayCelebration>(e =>
        {
            e.ToTable("play_celebrations");
            e.HasKey(c => c.Id);
            e.Property(c => c.Kind).HasMaxLength(PlayCelebration.KindMaxLength).IsRequired();
            e.Property(c => c.DedupeKey).HasMaxLength(PlayCelebration.DedupeKeyMaxLength).IsRequired();
            e.Property(c => c.BadgeKey).HasMaxLength(MemberBadge.BadgeKeyMaxLength);
            e.Property(c => c.Month).HasMaxLength(7);
            e.HasIndex(c => new { c.TenantId, c.UserId, c.DedupeKey }).IsUnique();
            e.HasIndex(c => new { c.TenantId, c.UserId }).HasFilter("\"SeenAt\" IS NULL");
            e.HasQueryFilter(c => c.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<MemberPlayProfile>(e =>
        {
            e.ToTable("member_play_profiles");
            e.HasKey(p => p.Id);
            // No database defaults, deliberately: EF omits a property whose value equals the CLR
            // default from an INSERT, so a `false` written by the app would read back as a
            // database default of `true` (the CourtLightState trap). The entity's initialisers
            // carry the defaults instead.
            e.Property(p => p.Version).IsConcurrencyToken();
            e.HasIndex(p => new { p.TenantId, p.UserId }).IsUnique();
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<MemberStreakPause>(e =>
        {
            e.ToTable("member_streak_pauses");
            e.HasKey(p => p.Id);
            // At most one open pause per member.
            e.HasIndex(p => new { p.TenantId, p.UserId }).IsUnique().HasFilter("\"EndedAt\" IS NULL");
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });
    }

    private void ConfigureMatchResults(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<MatchResult>(e =>
        {
            e.ToTable("match_results", t =>
            {
                t.HasCheckConstraint("ck_match_results_games_won", "\"GamesWonA\" <> \"GamesWonB\"");
                t.HasCheckConstraint("ck_match_results_winner", "\"WinnerSide\" IN ('a','b')");
                t.HasCheckConstraint("ck_match_results_format", "\"Format\" IN ('best_of_3','best_of_5')");
                t.HasCheckConstraint(
                    "ck_match_results_status", "\"Status\" IN ('pending','confirmed','disputed','voided','withdrawn')");
            });
            e.HasKey(r => r.Id);
            e.Property(r => r.Status).HasMaxLength(MatchResult.StatusMaxLength).IsRequired();
            e.Property(r => r.Format).HasMaxLength(MatchResult.FormatMaxLength).IsRequired();
            e.Property(r => r.GamesJson).HasColumnType("jsonb").IsRequired();
            e.Property(r => r.WinnerSide).HasColumnType("character(1)").IsRequired();
            e.Property(r => r.DisputeNote).HasMaxLength(MatchResult.DisputeNoteMaxLength);
            e.Property(r => r.CloseReason).HasMaxLength(MatchResult.CloseReasonMaxLength);
            e.Property(r => r.IdempotencyKey).HasMaxLength(MatchResult.IdempotencyKeyMaxLength).IsRequired();
            e.Property(r => r.Version).IsConcurrencyToken();
            e.HasOne<Booking>().WithMany().HasForeignKey(r => r.BookingId).OnDelete(DeleteBehavior.Restrict);
            e.HasMany(r => r.Players).WithOne().HasForeignKey(p => p.ResultId).OnDelete(DeleteBehavior.Cascade);

            // One LIVE result per booking. A voided or withdrawn row keeps its history and frees it.
            e.HasIndex(r => new { r.TenantId, r.BookingId }).IsUnique()
                .HasFilter("\"Status\" IN ('pending','confirmed','disputed')")
                .HasDatabaseName("IX_match_results_live_per_booking");
            // Every result on a booking, newest first: the booking's "latest closed" read.
            e.HasIndex(r => new { r.TenantId, r.BookingId, r.CreatedAt });
            // A replayed create finds its row.
            e.HasIndex(r => new { r.TenantId, r.RecordedByUserId, r.IdempotencyKey }).IsUnique();
            // The auto-confirm sweep and the admin disputes list.
            e.HasIndex(r => new { r.TenantId, r.ConfirmDueAt }).HasFilter("\"Status\" = 'pending'");
            e.HasIndex(r => new { r.TenantId, r.DisputedAt }).HasFilter("\"Status\" = 'disputed'");
            e.HasIndex(r => new { r.TenantId, r.Status, r.CreatedAt });
            e.HasQueryFilter(r => r.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<MatchResultPlayer>(e =>
        {
            e.ToTable("match_result_players", t =>
            {
                t.HasCheckConstraint("ck_match_result_players_side", "\"Side\" IN ('a','b')");
                t.HasCheckConstraint("ck_match_result_players_position", "\"Position\" IN (1, 2)");
                t.HasCheckConstraint(
                    "ck_match_result_players_who",
                    "(\"UserId\" IS NOT NULL AND \"GuestName\" IS NULL AND \"ParticipantId\" IS NULL) " +
                    "OR (\"UserId\" IS NULL AND \"GuestName\" IS NOT NULL AND \"ParticipantId\" IS NOT NULL)");
            });
            e.HasKey(p => p.Id);
            e.Property(p => p.Side).HasColumnType("character(1)").IsRequired();
            e.Property(p => p.GuestName).HasMaxLength(BookingParticipant.GuestNameMaxLength);
            e.HasIndex(p => new { p.ResultId, p.Side, p.Position }).IsUnique();
            e.HasIndex(p => new { p.ResultId, p.UserId }).IsUnique().HasFilter("\"UserId\" IS NOT NULL");
            // Every per-member stats read.
            e.HasIndex(p => new { p.TenantId, p.UserId });
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });
    }
}
