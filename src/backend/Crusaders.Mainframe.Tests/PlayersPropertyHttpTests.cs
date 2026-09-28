using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A seeded, deterministic property search over the players money (D11), on Postgres, through the
/// real endpoints, the settlement and credit hooks and the minute sweep (review round 6).
///
/// <para>
/// Each seed builds a club with 2–4 games — some cancelled after check-in (S4) — and 1–3 partners
/// each, then runs a random sequence of withdrawals, organiser and desk removals, settle-outsides,
/// cancellations, desk credits (some naming a game) and debits, top-ups, deadlines passing, and
/// reconciles in random order. After every step it checks the ledger against an INDEPENDENT model
/// built from raw rows — holds, owed-back and coverage recomputed here from the documented rules
/// (<c>players-and-splits.md</c> §3/§3a), not by calling <see cref="ShareHolds"/>:
/// </para>
/// <list type="bullet">
///   <item>no balance below zero without an explicit overdraft (the organiser's desk debits excepted);</item>
///   <item>share transfers come in exact out/in pairs and net to zero;</item>
///   <item>the wallet's <c>spendable = balance − held − owed_back</c>, and held and owed_back are the model's;</item>
///   <item>a return is waiting exactly when one is due and not made (no stale stamps);</item>
///   <item>no waiting return is covered by the documented formula — which is what "no ordinary
///   return waits", first come first served, and "no return waits while free money covers it" say;</item>
///   <item>a desk remove / settle-outside is refused exactly when the model says the hand-back is
///   not covered, and when accepted the ledger agrees (<c>return_waiting</c> false).</item>
/// </list>
///
/// <para>
/// <b>Cost.</b> 150 seeds by default (the three regression seeds included); set
/// <c>PLAYERS_PROPERTY_SEEDS</c> to run more, <c>PLAYERS_PROPERTY_FIRST_SEED</c> to move the window.
/// A failure names the seed and the steps that led to it.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class PlayersPropertyHttpTests
{
    private readonly PostgresFixture _pg;

    public PlayersPropertyHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>Seeds the refuter's search found the round-6 defect with; always run.</summary>
    private static readonly int[] RegressionSeeds = [1005, 1053, 1113];

    private static IReadOnlyList<int> Seeds()
    {
        var count = int.TryParse(Environment.GetEnvironmentVariable("PLAYERS_PROPERTY_SEEDS"), out var n) && n > 0 ? n : 150;
        var first = int.TryParse(Environment.GetEnvironmentVariable("PLAYERS_PROPERTY_FIRST_SEED"), out var s) ? s : 1;
        return RegressionSeeds.Concat(Enumerable.Range(first, Math.Max(0, count - RegressionSeeds.Length))).Distinct().ToList();
    }

    [SkippableFact]
    public async Task Players_money_holds_its_invariants_across_random_scenarios()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeds = Seeds();
        foreach (var seed in seeds)
        {
            var run = new Scenario(f, seed);
            try
            {
                await run.RunAsync();
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                throw new Xunit.Sdk.XunitException($"seed {seed} failed after {seeds.ToList().IndexOf(seed)} passing seeds:\n{string.Join("\n", run.Log)}\n{ex}");
            }
            finally
            {
                await run.ForgetMailAsync();
            }
        }
    }

    /// <summary>One seeded scenario: a club, its games, a random walk, and the checks after every step.</summary>
    private sealed class Scenario(TestWebAppFactory f, int seed)
    {
        private readonly Random _rng = new(seed);
        private PlayersClub _club = null!;
        private readonly List<Game> _games = [];
        private decimal _organiserFloor;

        public List<string> Log { get; } = [];

        /// <summary>
        /// The seed's own club's outbox rows, deleted: hundreds of clubs' invites and receipts left
        /// pending in the shared test database would sit in front of every other test (and every
        /// other lane) that drives the outbox a bounded number of times.
        /// </summary>
        public async Task ForgetMailAsync()
        {
            if (_club is null) return;
            var tenant = _club.TenantId;
            await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters().Where(n => n.TenantId == tenant).ExecuteDeleteAsync());
        }

        private sealed record Game(Guid Id, bool S4, List<(Guid Seat, Guid Who)> Partners);

        public async Task RunAsync()
        {
            _club = await PlayersClub.SeedAsync(f, $"prop{seed}");
            foreach (var who in Partners) await _club.CreditAsync(f, who, 60m);
            var games = _rng.Next(2, 5);
            for (var i = 0; i < games; i++) await AddGameAsync(i);
            await CheckAsync("setup");

            var steps = _rng.Next(5, 10);
            for (var step = 0; step < steps; step++)
            {
                var what = await StepAsync();
                await SweepAsync();
                await CheckAsync($"step {step}: {what}");
            }
        }

        private Guid[] Partners => [_club.Sam, _club.Alex, _club.Jo];

        private HttpClient Organiser => _club.Client(f, _club.Organiser);

        private HttpClient Admin => _club.Client(f, _club.Admin, admin: true);

        // -------------------------------------------------------------- setup

        private async Task AddGameAsync(int index)
        {
            var s4 = _rng.NextDouble() < 0.35;
            await _club.CreditAsync(f, _club.Organiser, 32m);
            var id = await _club.InsertBookingAsync(f, PlayersClub.Tomorrow(8).AddDays(index));
            var who = Partners.OrderBy(_ => _rng.Next()).Take(_rng.Next(1, 4)).ToList();
            // Multiples of 4, never more between them than the 32-credit court: up to 16 each for
            // one or two partners, up to 8 each for three.
            var most = Math.Min(4, 32 / (4 * who.Count));
            var amounts = who.Select(_ => (decimal)_rng.Next(1, most + 1) * 4m).ToList();
            var add = await Organiser.PostAsJsonAsync($"/api/v1/bookings/{id}/players", new
            {
                players = who.Select((w, i) => (object)new { userId = w, amount = amounts[i] }).ToArray(),
                splitMode = "amount",
            });
            var body = await add.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(add.IsSuccessStatusCode, body.ToString());
            var seats = body.GetProperty("participants").EnumerateArray().Select(p => p.GetProperty("participant_id").GetGuid()).ToList();
            for (var i = 0; i < who.Count; i++)
            {
                var accept = await _club.Client(f, who[i]).PostAsJsonAsync($"/api/v1/bookings/{id}/players/{seats[i]}/accept",
                    new { expectedShareCredits = amounts[i] });
                Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());
            }
            if (s4)
            {
                await _club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == id).CheckedInAt = DateTimeOffset.UtcNow);
                Assert.True((await Organiser.PostAsJsonAsync($"/api/v1/bookings/{id}/cancel", new { })).IsSuccessStatusCode);
            }
            _games.Add(new Game(id, s4, who.Select((w, i) => (seats[i], w)).ToList()));
            Log.Add($"game {index}: {id} s4={s4} partners={string.Join(",", amounts)}");
        }

        // -------------------------------------------------------------- steps

        private async Task<string> StepAsync()
        {
            var game = _games[_rng.Next(_games.Count)];
            var (seat, who) = game.Partners[_rng.Next(game.Partners.Count)];
            switch (_rng.Next(10))
            {
                case 0:
                    return await Status("withdraw", _club.Client(f, who).PostAsync($"/api/v1/bookings/{game.Id}/players/{seat}/withdraw", null));
                case 1:
                    return await Status("organiser remove", Organiser.DeleteAsync($"/api/v1/bookings/{game.Id}/players/{seat}"));
                case 2:
                    return await DeskHandBackAsync("remove", game, seat);
                case 3:
                    return await DeskHandBackAsync("settle-outside", game, seat);
                case 4:
                    return await Status("organiser cancel", Organiser.PostAsJsonAsync($"/api/v1/bookings/{game.Id}/cancel", new { }));
                case 5:
                    return await DeskAsync(_rng.Next(1, 11) * 4m, _rng.NextDouble() < 0.5 ? game.Id : null, "goodwill");
                case 6:
                    return await DeskAsync(_rng.Next(1, 7) * 4m, null, "top_up_cash");
                case 7:
                    return await DeskAsync(-_rng.Next(1, 11) * 4m, null, "correction");
                case 8:
                    await _club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == game.Id).ShareDeadlineAt = DateTimeOffset.UtcNow.AddMinutes(-1));
                    return $"deadline passes on {game.Id}";
                default:
                    foreach (var g in _games.OrderBy(_ => _rng.Next()))
                    {
                        await _club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(g.Id, default));
                    }
                    return "reconcile every game, random order";
            }
        }

        private async Task<string> Status(string what, Task<HttpResponseMessage> call)
        {
            var response = await call;
            Assert.True((int)response.StatusCode < 500, $"{what}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
            return $"{what} -> {(int)response.StatusCode}";
        }

        private async Task<string> DeskAsync(decimal amount, Guid? booking, string code)
        {
            var response = await Admin.PostAsJsonAsync($"/api/v1/admin/credit/{_club.Organiser}/adjust",
                new { amountCredits = amount, reason = "property step", reasonCode = code, relatedBookingId = booking });
            Assert.True(response.IsSuccessStatusCode, $"desk {amount}: {await response.Content.ReadAsStringAsync()}");
            if (amount < 0) _organiserFloor = Math.Min(_organiserFloor, await PlayersClub.BalanceAsync(f, _club.Organiser));
            return $"desk {code} {amount}{(booking is null ? "" : $" naming {booking}")}";
        }

        /// <summary>
        /// A desk hand-back without the overdraft: refused exactly when the model says it is not
        /// covered; when accepted, the ledger agrees — nothing is left waiting.
        /// </summary>
        private async Task<string> DeskHandBackAsync(string action, Game game, Guid seat)
        {
            var before = await ModelAsync();
            var row = before.Seats.Single(s => s.Seat.Id == seat);
            // Queued behind every waiting return — or, when this seat is already waiting, behind
            // those stamped before it — exactly as the desk's pre-check asks it.
            var queue = before.Waiting();
            var earlier = row.Seat.ReturnPendingSince is null ? queue : queue.TakeWhile(w => w.Seat.Id != seat).ToList();
            var covered = row.Paid <= 0m || before.Coverage(game.Id, seat, earlier) >= row.Paid;

            var response = await Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{game.Id}/players/{seat}/{action}", new { reason = "property step" });
            var text = await response.Content.ReadAsStringAsync();
            Assert.True((int)response.StatusCode < 500, $"desk {action}: {(int)response.StatusCode} {text}");
            if (response.StatusCode == HttpStatusCode.BadRequest && text.Contains(PlayerErrors.OverdraftNotAuthorised))
            {
                Assert.False(covered, $"desk {action} refused though the model covers {row.Paid}: {text}");
            }
            else if (response.IsSuccessStatusCode)
            {
                Assert.True(covered, $"desk {action} accepted though the model does not cover {row.Paid}: {text}");
                var answer = JsonDocument.Parse(text).RootElement;
                Assert.False(answer.GetProperty("return_waiting").GetBoolean(), $"desk {action} pre-check and ledger disagree: {text}");
            }
            return $"desk {action} {seat} -> {(int)response.StatusCode}";
        }

        private Task SweepAsync() => _club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
            return 0;
        });

        // -------------------------------------------------------------- checks

        private async Task CheckAsync(string after)
        {
            Log.Add(after);
            var m = await ModelAsync();

            foreach (var p in Partners) Assert.True(await PlayersClub.BalanceAsync(f, p) >= 0m, $"{after}: partner {p} below zero");
            Assert.True(m.Balance >= Math.Min(0m, _organiserFloor), $"{after}: organiser {m.Balance} below the desk's floor {_organiserFloor}");

            // Exact out/in pairs, netting to zero.
            foreach (var pair in m.Shares.GroupBy(l => l.ExternalReference![..l.ExternalReference!.LastIndexOf(':')]))
            {
                var legs = pair.ToList();
                Assert.True(legs.Count == 2 && legs.Sum(l => l.AmountCredits) == 0m
                            && legs.Any(l => l.ExternalReference!.EndsWith(":out")) && legs.Any(l => l.ExternalReference!.EndsWith(":in")),
                    $"{after}: broken share pair {pair.Key}");
            }
            Assert.Equal(0m, m.Shares.Sum(l => l.AmountCredits));

            // The wallet: raw balance, the model's held and owed-back, spendable their difference.
            var wallet = await Organiser.GetFromJsonAsync<JsonElement>("/api/v1/wallet");
            var (balance, held, owed, spendable) = (wallet.GetProperty("balance_credits").GetDecimal(), wallet.GetProperty("held_credits").GetDecimal(),
                wallet.GetProperty("owed_back_credits").GetDecimal(), wallet.GetProperty("spendable_credits").GetDecimal());
            Assert.True(balance == m.Balance, $"{after}: wallet balance {balance} != ledger {m.Balance}");
            Assert.True(spendable == balance - held - owed, $"{after}: spendable {spendable} != {balance} - {held} - {owed}");
            Assert.True(held == m.Holds.Values.Sum(), $"{after}: held {held} != model {m.Holds.Values.Sum()}");
            Assert.True(owed == m.OwedBack(m.Waiting()), $"{after}: owed back {owed} != model {m.OwedBack(m.Waiting())}");

            // Waiting exactly when due and not made; and never while the documented formula covers it.
            foreach (var s in m.Seats)
            {
                var waiting = s.Seat.ReturnPendingSince is not null;
                Assert.True(waiting == (s.Pending > 0m), $"{after}: seat {s.Seat.Id} waiting={waiting} but pending {s.Pending}");
            }
            var queue = m.Waiting();
            foreach (var s in queue)
            {
                var earlier = queue.TakeWhile(w => w.Seat.Id != s.Seat.Id).ToList();
                var coverage = m.Coverage(s.Seat.BookingId, s.Seat.Id, earlier);
                Assert.True(coverage < s.Pending, $"{after}: seat {s.Seat.Id} waits for {s.Pending} though the formula covers {coverage}");
            }
        }

        // -------------------------------------------------------------- the independent model

        private sealed record SeatRow(BookingParticipant Seat, decimal Paid, decimal Pending);

        private sealed class Model
        {
            public decimal Balance { get; init; }
            public List<LedgerEntry> Shares { get; init; } = [];
            public List<SeatRow> Seats { get; init; } = [];
            public Dictionary<Guid, decimal> Holds { get; init; } = [];
            public HashSet<Guid> AfterCheckIn { get; init; } = [];

            /// <summary>Waiting returns, first come first served: stamp, then participant id.</summary>
            public List<SeatRow> Waiting() => Seats.Where(s => s.Seat.ReturnPendingSince is not null)
                .OrderBy(s => s.Seat.ReturnPendingSince).ThenBy(s => s.Seat.Id).ToList();

            private decimal Earmark(Guid booking) => AfterCheckIn.Contains(booking) ? 0m : Holds.GetValueOrDefault(booking);

            public decimal OwedBack(IEnumerable<SeatRow> waiting) =>
                waiting.GroupBy(w => w.Seat.BookingId).Sum(g => Math.Max(0m, g.Sum(w => w.Pending) - Holds.GetValueOrDefault(g.Key)));

            /// <summary>§3's coverage, recomputed here from raw rows.</summary>
            public decimal Coverage(Guid booking, Guid seat, IEnumerable<SeatRow> earlier)
            {
                var need = earlier.Where(e => e.Seat.Id != seat).GroupBy(e => e.Seat.BookingId).ToDictionary(g => g.Key, g => g.Sum(e => e.Pending));
                var drawn = need.Sum(kv => Math.Min(kv.Value, Earmark(kv.Key)));
                var excess = need.Sum(kv => Math.Max(0m, kv.Value - Earmark(kv.Key)));
                var earmarked = Holds.Keys.Sum(Earmark);
                var mine = Math.Max(0m, Earmark(booking) - need.GetValueOrDefault(booking));
                var backed = Math.Max(0m, Math.Min(Balance, earmarked) - drawn);
                return Math.Min(mine, backed) + Math.Max(0m, Balance - earmarked - excess);
            }
        }

        private async Task<Model> ModelAsync()
        {
            var tenant = _club.TenantId;
            var ids = _games.Select(g => g.Id).ToList();
            var (bookings, seats, rows, settings) = await _club.InClubAsync(f, async sp =>
            {
                var db = sp.GetRequiredService<MainframeDbContext>();
                return (await db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToListAsync(),
                        await db.BookingParticipants.AsNoTracking().Where(p => ids.Contains(p.BookingId)).ToListAsync(),
                        await db.LedgerEntries.AsNoTracking().Where(l => l.TenantId == tenant).ToListAsync(),
                        await sp.GetRequiredService<TenantSettingsAccessor>().GetAsync(default));
            });
            var now = DateTimeOffset.UtcNow;
            var organiser = _club.Organiser;
            var seatRows = new List<SeatRow>();
            var holds = new Dictionary<Guid, decimal>();
            foreach (var b in bookings)
            {
                var owed = Math.Max(0m, -rows.Where(l => l.RelatedBookingId == b.Id && l.UserId == organiser && l.Type != LedgerEntryType.ShareTransfer).Sum(l => l.AmountCredits));
                var mine = new List<SeatRow>();
                foreach (var p in seats.Where(p => p.BookingId == b.Id && p.Seat > 1 && p.UserId is not null))
                {
                    var prefix = ShareLedger.Prefix(p.Id);
                    var paid = -rows.Where(l => l.UserId == p.UserId && l.Type == LedgerEntryType.ShareTransfer && l.ExternalReference!.StartsWith(prefix)).Sum(l => l.AmountCredits);
                    var closed = p.LapsedAt is not null || now >= PlayerSettings.ShareDeadline(b, settings);
                    var target = ShareLedger.TargetFor(b, p, owed, paid, closed);   // the rule table, pinned on its own
                    mine.Add(new SeatRow(p, paid, Math.Max(0m, paid - target)));
                }
                seatRows.AddRange(mine);
                // §3a: a game holds what its organiser received on it, net, until its deadline; a
                // cancelled one only what it will still hand back, and never more than it received.
                var received = rows.Where(l => l.RelatedBookingId == b.Id && l.UserId == organiser && l.Type == LedgerEntryType.ShareTransfer).Sum(l => l.AmountCredits);
                if (now >= PlayerSettings.ShareDeadline(b, settings) || received <= 0m) continue;
                var hold = b.Status == BookingStatus.Cancelled ? Math.Min(mine.Sum(s => s.Pending), received) : received;
                if (hold > 0m) holds[b.Id] = hold;
            }
            return new Model
            {
                Balance = rows.Where(l => l.UserId == organiser).Sum(l => l.AmountCredits),
                Shares = rows.Where(l => l.Type == LedgerEntryType.ShareTransfer).ToList(),
                Seats = seatRows,
                Holds = holds,
                AfterCheckIn = bookings.Where(b => b.Status == BookingStatus.Cancelled && b.CheckedInAt != null).Select(b => b.Id).ToHashSet(),
            };
        }
    }
}
