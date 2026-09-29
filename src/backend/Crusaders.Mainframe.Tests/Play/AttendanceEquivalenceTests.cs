using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// P12 rewrote <see cref="AttendanceQuery.SessionsAsync"/> from one statement (an OR across a join
/// plus correlated subqueries, which Postgres mis-estimated into a JIT compile on every call) into
/// two plain reads joined in memory. This pins the rewrite to the statement it replaced: on a
/// deliberately messy seeded history — admin blocks, guests, every seat status, a member re-invited
/// after declining, seat and booking check-ins in every combination, cancellations before and after
/// the end — both return exactly the same sessions for every member.
/// </summary>
public sealed class AttendanceEquivalenceTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    [SkippableFact]
    public async Task The_two_read_sessions_query_returns_what_the_single_statement_did_for_every_member()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "att-equiv");
        Guid[] members = [club.Organiser, club.Sam, club.Alex, club.Jo, club.Bystander, club.Admin];
        await club.WriteAsync(f, db => SeedHistory(db, club, members, new Random(20260929)));

        var total = 0;
        foreach (var member in members)
        {
            var (legacy, current) = await club.InClubAsync(f, async sp =>
            {
                var db = sp.GetRequiredService<MainframeDbContext>();
                return (await LegacySessionsAsync(db, member), await AttendanceQuery.SessionsAsync(db, member, CancellationToken.None));
            });
            Assert.Equal(Flatten(legacy), Flatten(current));
            total += current.Count;
        }
        Assert.True(total > 60, $"the seeded history should attend plenty of sessions, got {total}");
    }

    private static List<string> Flatten(List<AttendedSession> sessions) =>
        sessions.Select(s => $"{s.BookingId}|{s.StartsAt:O}|{s.EvidenceAt:O}|{s.PlayedMinutes}|{string.Join(',', s.OtherPlayers.Order())}").ToList();

    private static void SeedHistory(MainframeDbContext db, PlayersClub club, Guid[] members, Random rng)
    {
        var origin = DateTimeOffset.UtcNow.AddDays(-60).Storable();
        for (var i = 0; i < 160; i++)
        {
            var starts = origin.AddHours(i);
            var booker = rng.Next(8) == 0 ? (Guid?)null : members[rng.Next(members.Length)];
            var booking = new Booking
            {
                TenantId = club.TenantId, CourtId = club.CourtId, UserId = booker, BookedByUserId = booker, PaidByUserId = booker,
                ActorUserId = booker ?? club.Admin, StartsAt = starts, EndsAt = starts.AddMinutes(45), SliceMinutes = 15, SliceCount = 3,
                AmountChargedCredits = booker is null ? 0m : 24m,
                Status = booker is null ? BookingStatus.AdminBlock : (BookingStatus)rng.Next(4),
                CheckedInAt = rng.Next(3) > 0 ? starts.AddMinutes(rng.Next(1, 10)) : null,
                CancelledAt = rng.Next(5) == 0 ? starts.AddMinutes(rng.Next(-30, 60)) : null,
            };
            db.Bookings.Add(booking);
            AddSeats(db, club, booking, members, rng);
        }
    }

    /// <summary>
    /// Up to four live seats (distinct seat, distinct member — the partial unique indexes), plus
    /// history rows in the dead statuses that may repeat a live member, and the odd guest.
    /// </summary>
    private static void AddSeats(MainframeDbContext db, PlayersClub club, Booking booking, Guid[] members, Random rng)
    {
        var liveUsers = members.OrderBy(_ => rng.Next()).Take(rng.Next(5)).ToList();
        var seat = 1;
        foreach (var user in liveUsers)
        {
            db.BookingParticipants.Add(Seat(club, booking, seat++, user, (ParticipantStatus)rng.Next(2), rng));
        }
        if (seat <= 4 && rng.Next(4) == 0)
        {
            var guest = Seat(club, booking, seat, null, ParticipantStatus.Accepted, rng);
            guest.GuestName = "Guest";
            guest.CheckedInAt = null;
            db.BookingParticipants.Add(guest);
        }
        for (var h = rng.Next(3); h > 0; h--)
        {
            db.BookingParticipants.Add(Seat(club, booking, rng.Next(1, 5), members[rng.Next(members.Length)], (ParticipantStatus)rng.Next(2, 6), rng));
        }
    }

    private static BookingParticipant Seat(PlayersClub club, Booking booking, int seat, Guid? user, ParticipantStatus status, Random rng) => new()
    {
        TenantId = club.TenantId, BookingId = booking.Id, Seat = seat, UserId = user, Status = status, ShareWeight = 1,
        CheckedInAt = rng.Next(3) == 0 ? booking.StartsAt.AddMinutes(rng.Next(0, 20)) : null,
        InvitedAt = booking.StartsAt.AddDays(-1), CreatedAt = booking.StartsAt.AddDays(-1), UpdatedAt = booking.StartsAt.AddDays(-1),
    };

    /// <summary>The statement <see cref="AttendanceQuery.SessionsAsync"/> used before P12, verbatim — the reference.</summary>
    private static async Task<List<AttendedSession>> LegacySessionsAsync(MainframeDbContext db, Guid userId)
    {
        var rows = await db.Bookings.AsNoTracking()
            .Where(b => b.UserId != null
                        && (b.UserId == userId || db.BookingParticipants.Any(p => p.BookingId == b.Id && p.UserId == userId)))
            .Select(b => new
            {
                b.Id, b.UserId, b.StartsAt, b.EndsAt, b.CancelledAt, b.CheckedInAt,
                Own = db.BookingParticipants
                    .Where(p => p.BookingId == b.Id && p.UserId == userId && p.CheckedInAt != null)
                    .Min(p => p.CheckedInAt),
                Accepted = db.BookingParticipants
                    .Any(p => p.BookingId == b.Id && p.UserId == userId && p.Status == ParticipantStatus.Accepted),
            })
            .Where(x => x.Own != null || (x.CheckedInAt != null && (x.UserId == userId || x.Accepted)))
            .ToListAsync();
        if (rows.Count == 0) return [];

        var ids = rows.Select(r => r.Id).ToList();
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => ids.Contains(p.BookingId) && p.UserId != null && p.Status == ParticipantStatus.Accepted)
            .Select(p => new { p.BookingId, UserId = p.UserId!.Value })
            .ToListAsync();
        var seated = seats.ToLookup(s => s.BookingId, s => s.UserId);

        return rows
            .Select(r => new AttendedSession(
                r.Id, r.StartsAt, (r.Own ?? r.CheckedInAt)!.Value, AttendanceQuery.PlayedMinutes(r.StartsAt, r.EndsAt, r.CancelledAt),
                seated[r.Id].Prepend(r.UserId!.Value).Where(u => u != userId).Distinct().ToList()))
            .OrderBy(s => s.EvidenceAt).ThenBy(s => s.BookingId)
            .ToList();
    }
}
