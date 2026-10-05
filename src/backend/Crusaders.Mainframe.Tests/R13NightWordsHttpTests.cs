using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, lane BE13a: what the admin Night says about a partner's withdrawal (E13-4) and a
/// displaced booking (E13-8).
/// <list type="bullet">
/// <item>E13-4: the withdrawal wrote no row, and the share going back was the club's system — "A share
/// of a split booking moved: 7 minutes … by the club's own automatic check". The withdrawal is now a
/// row BY THE PARTNER on both members' nights (C13-4's <c>players.withdrew</c>), and the share return
/// says it was caused by it and names the partner — also for a return posted before R13, whose stored
/// actor is the system: only the partner can withdraw their own seat, so the seat is the evidence.</item>
/// <item>E13-8: "The club moved this booking on a court aside" named no court, did not say it was
/// cancelled and refunded, and not why. It names the court through the booking, says both, and names
/// whose earlier booking's late check-in caused it when the record knows.</item>
/// </list>
/// Rows are seeded in the writers' own shapes (BookingService.DisplacedAudit, C13-4, ShareLedger.Pair),
/// so the words are tested apart from the flows that write them.
/// </summary>
public sealed class R13NightWordsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<List<JsonElement>> NightAsync(PlayersClub club, TestWebAppFactory app, Guid user)
    {
        var body = await club.Client(app, club.Admin, admin: true).GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    private static string Kind(JsonElement e) => e.GetProperty("kind").GetString()!;
    private static string Headline(JsonElement e) => e.GetProperty("headline").GetString()!;
    private static string ActorKind(JsonElement e) => e.GetProperty("actor").GetProperty("kind").GetString()!;
    private static string? ActorName(JsonElement e) => e.GetProperty("actor").GetProperty("name").GetString();

    /// <summary>
    /// Olive's booking, Sam's seat paid 7 at seq 0 then withdrawn and returned at seq 1 — the return's
    /// actor as <paramref name="returnActor"/> says (the system before R13, Sam since). With
    /// <paramref name="partners"/> 2, Alex is on the game too and paid, and stays.
    /// </summary>
    private static async Task<(Guid Booking, Guid Seat)> WithdrawnAsync(PlayersClub club, TestWebAppFactory app, Guid returnActor, int partners)
    {
        var booking = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(2).Storable());
        var now = DateTimeOffset.UtcNow.Storable();
        var sam = new BookingParticipant
        {
            TenantId = club.TenantId,
            BookingId = booking,
            Seat = 2,
            UserId = club.Sam,
            Status = ParticipantStatus.Withdrawn,
            ShareMinutes = 7,
            ShareWeight = 1,
            InvitedAt = now.AddMinutes(-30),
            RespondedAt = now.AddMinutes(-5),
            CreatedAt = now.AddMinutes(-30),
            UpdatedAt = now.AddMinutes(-5),
        };
        var alex = new BookingParticipant
        {
            TenantId = club.TenantId,
            BookingId = booking,
            Seat = 3,
            UserId = club.Alex,
            Status = ParticipantStatus.Accepted,
            ShareMinutes = 7,
            ShareWeight = 1,
            InvitedAt = now.AddMinutes(-30),
            RespondedAt = now.AddMinutes(-20),
            CreatedAt = now.AddMinutes(-30),
            UpdatedAt = now.AddMinutes(-20),
        };
        await club.WriteAsync(app, db =>
        {
            db.BookingParticipants.Add(sam);
            if (partners > 1) db.BookingParticipants.Add(alex);
            void Pair(BookingParticipant seat, int seq, Guid from, Guid to, Guid actor, DateTimeOffset at, string reason)
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId,
                    UserId = from,
                    Type = LedgerEntryType.ShareTransfer,
                    AmountMinutes = -7,
                    ActorUserId = actor,
                    RelatedBookingId = booking,
                    Reason = reason,
                    ExternalReference = ShareLedger.Reference(seat.Id, seq, "out"),
                    CreatedAt = at,
                });
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId,
                    UserId = to,
                    Type = LedgerEntryType.ShareTransfer,
                    AmountMinutes = 7,
                    ActorUserId = actor,
                    RelatedBookingId = booking,
                    Reason = reason,
                    ExternalReference = ShareLedger.Reference(seat.Id, seq, "in"),
                    CreatedAt = at,
                });
            }
            Pair(sam, 0, club.Sam, club.Organiser, club.Sam, now.AddMinutes(-20), "Share of a split booking");
            if (partners > 1) Pair(alex, 0, club.Alex, club.Organiser, club.Alex, now.AddMinutes(-19), "Share of a split booking");
            Pair(sam, 1, club.Organiser, club.Sam, returnActor, now.AddMinutes(-4), "Share of a split booking returned");
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = club.TenantId,
                ActorUserId = club.Sam,
                SubjectUserId = club.Sam,
                Action = "players.withdrew",
                ScanAt = now.AddMinutes(-5),
                CreatedAt = now.AddMinutes(-5),
                DetailsJson = JsonSerializer.Serialize(new
                {
                    booking_id = booking,
                    participant_id = sam.Id,
                    organiser_user_id = club.Organiser,
                    court_number = 1,
                    starts_at = now.AddDays(2),
                    paid_minutes = 7,
                }),
            });
        });
        return (booking, sam.Id);
    }

    [SkippableTheory]
    [InlineData(1, true)]
    [InlineData(2, true)]
    [InlineData(1, false)]
    [InlineData(2, false)]
    public async Task A_withdrawal_is_the_partners_row_and_the_share_return_says_so(int partners, bool legacySystemActor)
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, $"r13nw{partners}{(legacySystemActor ? "l" : "n")}");
        await WithdrawnAsync(club, app, legacySystemActor ? Guid.Empty : club.Sam, partners);

        // Sam's night: his own withdrawal, and his share coming back because of it — his act, not the club's check.
        var sam = await NightAsync(club, app, club.Sam);
        var withdrew = Assert.Single(sam, e => Kind(e) == TraceKinds.BookingWithdrew);
        Assert.Equal("Withdrew from Olive Organiser's game on Court 1", Headline(withdrew));
        Assert.True(withdrew.GetProperty("actor").GetProperty("is_self").GetBoolean());
        var back = Assert.Single(sam, e => Kind(e) == TraceKinds.WalletShareMoved && e.GetProperty("amount_minutes").ValueKind == JsonValueKind.Number
                                             && e.GetProperty("amount_minutes").GetInt32() == 7);
        // R16 E16-4: through the share sentence — the court, and whose game.
        Assert.Equal("7 minutes of their share of Court 1 came back from Olive Organiser — they withdrew from the game", Headline(back));
        Assert.Equal(TraceActors.Member, ActorKind(back));
        Assert.Equal("Sam Partner", ActorName(back));
        // The payment before the withdrawal is not the withdrawal's.
        var paid = Assert.Single(sam, e => Kind(e) == TraceKinds.WalletShareMoved && e.GetProperty("amount_minutes").ValueKind == JsonValueKind.Number
                                             && e.GetProperty("amount_minutes").GetInt32() == -7);
        Assert.DoesNotContain("withdrew", Headline(paid), StringComparison.Ordinal);
        Assert.DoesNotContain(sam, e => Headline(e).Contains("automatic", StringComparison.Ordinal));

        // Olive's night: Sam withdrew from her game, and 7 went back to him because of it.
        var olive = await NightAsync(club, app, club.Organiser);
        var partner = Assert.Single(olive, e => Kind(e) == TraceKinds.BookingPartnerWithdrew);
        Assert.Equal("Sam Partner withdrew from their game on Court 1", Headline(partner));
        Assert.Equal("Sam Partner", ActorName(partner));
        var out7 = Assert.Single(olive, e => Kind(e) == TraceKinds.WalletShareMoved && e.GetProperty("amount_minutes").ValueKind == JsonValueKind.Number
                                               && e.GetProperty("amount_minutes").GetInt32() == -7);
        Assert.Equal("7 minutes went back to Sam Partner for their share of Court 1 — Sam Partner withdrew from the game", Headline(out7));
        Assert.Equal(TraceActors.Member, ActorKind(out7));
        Assert.Equal("Sam Partner", ActorName(out7));
        Assert.DoesNotContain(olive, e => Headline(e).Contains("automatic", StringComparison.Ordinal));
        // Alex, still on the game, is untouched by any of it.
        Assert.DoesNotContain(olive, e => Headline(e).Contains("Alex", StringComparison.Ordinal) && Headline(e).Contains("withdrew", StringComparison.Ordinal));
    }

    /// <summary>Somebody who is neither the partner nor the organiser never sees the withdrawal.</summary>
    [SkippableFact]
    public async Task A_bystanders_night_has_no_withdrawal()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, "r13nwby");
        await WithdrawnAsync(club, app, club.Sam, 2);

        Assert.DoesNotContain(await NightAsync(club, app, club.Alex),
            e => Kind(e) is TraceKinds.BookingWithdrew or TraceKinds.BookingPartnerWithdrew);
        Assert.Empty(await NightAsync(club, app, club.Bystander));
    }

    /// <summary>E13-8: the court, the cancellation and the refund, and whose late check-in it was.</summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_displaced_booking_names_its_court_its_refund_and_its_cause(bool causeKnown)
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, $"r13nd{(causeKnown ? "k" : "u")}");
        var start = DateTimeOffset.UtcNow.AddHours(-2).Storable();
        var earlier = await club.InsertBookingAsync(app, start);
        var displaced = await club.InsertBookingAsync(app, start.AddMinutes(32), organiser: club.Sam);
        await club.WriteAsync(app, db => db.AuditLogs.Add(new AuditLog
        {
            TenantId = club.TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = club.Sam,
            Action = "booking.displaced",
            DetailsJson = JsonSerializer.Serialize(new
            {
                booking_id = displaced,
                displaced_by_booking_id = causeKnown ? earlier : Guid.NewGuid(),
                refund_minutes = 32,
                reason = BookingService.ResoldTailRefunded,
            }),
        }));

        var row = Assert.Single(await NightAsync(club, app, club.Sam), e => Kind(e) == TraceKinds.BookingDisplaced);
        Assert.Equal(
            causeKnown
                ? "The club cancelled this booking on Court 1 and refunded it — Olive Organiser's earlier booking there was checked in late"
                : "The club cancelled this booking on Court 1 and refunded it — an earlier booking there was checked in late",
            Headline(row));
        Assert.Equal("Court 1", row.GetProperty("court").GetProperty("name").GetString());
    }
}
