using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The players-and-splits tables (D11–D13), in a partial of their own for the 200-line reason
/// every table since the devices one has been lifted out for — and in the SAME class, because a
/// query filter must reference this context's own tenant field for EF to parameterise it per
/// instance. A filter built in another class over a captured context would freeze the first
/// context's tenant into the model, which is a cross-tenant leak by construction.
/// </summary>
public partial class MainframeDbContext
{
    /// <summary>The players on each booking. See <see cref="BookingParticipant"/>.</summary>
    public DbSet<BookingParticipant> BookingParticipants => Set<BookingParticipant>();

    /// <summary>Each member's starred partners. Private to the member who starred them.</summary>
    public DbSet<PartnerFavourite> PartnerFavourites => Set<PartnerFavourite>();

    /// <summary>Each member's in-app inbox — the bell.</summary>
    public DbSet<MemberNotification> MemberNotifications => Set<MemberNotification>();

    private void ConfigurePlayers(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<BookingParticipant>(e =>
        {
            e.ToTable("booking_participants", t =>
            {
                // The four-player ceiling is the DATABASE's: seats are 1–4 and a live seat is
                // unique per booking, so a fifth live row has no seat to take.
                t.HasCheckConstraint("ck_booking_participants_seat", "\"Seat\" BETWEEN 1 AND 4");
                t.HasCheckConstraint("ck_booking_participants_status", "\"Status\" BETWEEN 0 AND 5");
                t.HasCheckConstraint(
                    "ck_booking_participants_money",
                    "\"ShareMinutes\" >= 0 AND \"ConsentedMinutes\" >= 0 AND \"ShareWeight\" >= 0");
                t.HasCheckConstraint("ck_booking_participants_shortfall", "\"ShortfallMinutes\" >= 0");
                // A guest pays nothing and is nobody's account.
                t.HasCheckConstraint(
                    "ck_booking_participants_guest",
                    "\"GuestName\" IS NULL OR (\"UserId\" IS NULL AND \"ShareMinutes\" = 0)");
            });
            e.HasKey(p => p.Id);
            e.Property(p => p.Status).HasConversion<int>();
            e.Property(p => p.GuestName).HasMaxLength(BookingParticipant.GuestNameMaxLength);
            e.Property(p => p.SplitMode).HasMaxLength(BookingParticipant.SplitModeMaxLength);
            e.Property(p => p.InviteTokenHash).HasMaxLength(BookingParticipant.TokenHashLength);
            e.Property(p => p.Version).IsConcurrencyToken();

            // One LIVE row per seat, and one live seat per member, per booking. Partial on the
            // live statuses so a declined or removed row keeps its history without holding the
            // seat — and so re-inviting somebody who said no is a new row, not an edit of a
            // "no" into a "yes".
            e.HasIndex(p => new { p.TenantId, p.BookingId, p.Seat })
                .IsUnique().HasFilter("\"Status\" IN (0, 1)");
            e.HasIndex(p => new { p.TenantId, p.BookingId, p.UserId })
                .IsUnique().HasFilter("\"Status\" IN (0, 1) AND \"UserId\" IS NOT NULL");

            // A link is found by its hash and nothing else. Global rather than per club because
            // the link is resolved before anything else is known about it.
            e.HasIndex(p => p.InviteTokenHash).IsUnique().HasFilter("\"InviteTokenHash\" IS NOT NULL");

            // "My invites", "my recent partners", the gate's and the court box's "is this person
            // on a live booking" — every reader asks by member.
            e.HasIndex(p => new { p.TenantId, p.UserId, p.Status });
            // "This member's seat on this booking, in ANY status" — or in a non-live one (the
            // booking detail's "were you removed?"). The unique index above has the same columns
            // but is partial on the live statuses, so it cannot answer a question that does not
            // name a live status; without this one Postgres walked every seat the member has ever
            // held for every booking — 1.6M buffer hits and ~1.5 s for one /me/play at 2,000
            // bookings (P10 perf pass), 17k with it. Play's attendance read no longer probes per
            // booking since P12 rewrote it (see AttendanceQuery.SessionsAsync).
            e.HasIndex(p => new { p.TenantId, p.BookingId, p.UserId }, "IX_booking_participants_TenantId_BookingId_UserId_any");
            // The sweep's retry of waiting returns: a handful of rows, found without a scan.
            e.HasIndex(p => new { p.TenantId, p.ReturnPendingSince }).HasFilter("\"ReturnPendingSince\" IS NOT NULL");
            // The lapse sweep's overdue invites, whatever their age: only unanswered seats are in it.
            e.HasIndex(p => new { p.TenantId, p.BookingId }).HasFilter("\"Status\" = 0 AND \"LapsedAt\" IS NULL")
                .HasDatabaseName("IX_booking_participants_open_invites");
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<PartnerFavourite>(e =>
        {
            e.ToTable("partner_favourites", t =>
                t.HasCheckConstraint("ck_partner_favourites_not_self", "\"UserId\" <> \"PartnerUserId\""));
            e.HasKey(f => f.Id);
            e.HasIndex(f => new { f.TenantId, f.UserId, f.PartnerUserId }).IsUnique();
            e.HasQueryFilter(f => f.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<MemberNotification>(e =>
        {
            e.ToTable("member_notifications");
            e.HasKey(n => n.Id);
            e.Property(n => n.Kind).HasMaxLength(MemberNotification.KindMaxLength).IsRequired();
            e.Property(n => n.Headline).HasMaxLength(MemberNotification.HeadlineMaxLength).IsRequired();
            e.Property(n => n.Link).HasMaxLength(MemberNotification.LinkMaxLength);
            e.Property(n => n.DedupeKey).HasMaxLength(MemberNotification.DedupeKeyMaxLength).IsRequired();
            e.HasIndex(n => new { n.TenantId, n.DedupeKey }).IsUnique();
            // The inbox pages one member newest first, and the badge counts their unread.
            e.HasIndex(n => new { n.TenantId, n.UserId, n.CreatedAt, n.Id });
            e.HasIndex(n => new { n.TenantId, n.UserId }).HasFilter("\"ReadAt\" IS NULL");
            e.HasQueryFilter(n => n.TenantId == _tenant.TenantId);
        });
    }
}
