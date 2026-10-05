using System.Net.Http.Json;
using System.Threading.Channels;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13 (BE13a's note to BE13b, the E13-2 shape): <c>booking.created</c> said
/// <c>actor.is_admin = actorId != userId</c> — the guess E13-2 removed from the ledger's mirror. An
/// admin booking their own court went out as a member; anybody booking for somebody else went out as
/// an administrator. It is the actor's own role now.
/// </summary>
public sealed class R13BookingCreatedActorHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed class RecordingBus : IEventBus
    {
        private readonly Channel<DomainEvent> _channel = Channel.CreateUnbounded<DomainEvent>();
        private readonly List<DomainEvent> _emitted = [];

        public ChannelReader<DomainEvent> Reader => _channel.Reader;

        public List<DomainEvent> Emitted
        {
            get { lock (_emitted) return [.. _emitted]; }
        }

        public async ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default)
        {
            lock (_emitted) _emitted.Add(evt);
            await _channel.Writer.WriteAsync(evt, ct);
        }
    }

    private async Task<(PlayersClub Club, WebApplicationFactory<Program> App, RecordingBus Bus)> RigAsync(string prefix)
    {
        var bus = new RecordingBus();
        var app = pg.SharedHost.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEventBus>();
            s.AddSingleton<IEventBus>(bus);
        }));
        var club = await PlayersClub.SeedAsync(app, prefix);
        foreach (var who in new[] { club.Admin, club.Organiser, club.Sam }) await club.CreditAsync(app, who, 100);
        return (club, app, bus);
    }

    private static DomainEvent Created(RecordingBus bus, Guid subject) =>
        Assert.Single(bus.Emitted, e => e.Type == "booking.created" && e.SubjectUserId == subject);

    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Booking_your_own_court_names_your_real_role(bool admin)
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, app, bus) = await RigAsync(admin ? "r13bcadm" : "r13bcmem");
        var who = admin ? club.Admin : club.Organiser;

        (await club.Client(app, who, admin).PostAsJsonAsync("/api/v1/bookings",
            new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(), sliceCount = 2 })).EnsureSuccessStatusCode();

        var created = Created(bus, who);
        Assert.Equal(who, created.ActorUserId);
        Assert.Equal(admin, created.ActorIsAdmin);
    }

    /// <summary>A member acting for another member is not an administrator for it.</summary>
    [SkippableFact]
    public async Task A_member_booking_for_somebody_else_is_not_named_an_admin()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, app, bus) = await RigAsync("r13bcfor");

        var result = await club.InClubAsync(app, sp => sp.GetRequiredService<BookingService>()
            .CreateAsync(club.CourtId, club.Sam, club.Organiser, PlayersClub.Tomorrow(10), 2, default));
        Assert.IsType<BookingResult.Ok>(result);

        var created = Created(bus, club.Sam);
        Assert.Equal(club.Organiser, created.ActorUserId);
        Assert.False(created.ActorIsAdmin);
    }
}
