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
///   not covered, and when accepted the ledger agrees (<c>return_waiting</c> false);</item>
///   <item>LIVENESS — when the balance covers every earmark and every pending return, nothing
///   waits; and at the end, topped up to exactly that, nothing is left pending (round 7);</item>
///   <item>the running balance is never below zero at any return row (no overdraft is ever asked
///   for here);</item>
///   <item>FIRST COME FIRST SERVED across each step — no return posts from money beyond its own
///   game's earmark while one stamped before the step still waits;</item>
///   <item>an organiser's spend is allowed exactly when the model's spendable covers the price.</item>
/// </list>
///
/// <para>
/// Steps (round 7 additions in brackets): withdrawals, organiser and desk removals,
/// settle-outsides, cancellations, desk credits (some naming a game) and debits, top-ups,
/// deadlines passing, reconciles in random order, [an organiser's spend, a check-in + cancel
/// mid-run (a game becoming S4), a lowered share, and a CONCURRENT step: every game's reconcile,
/// a sweep, a desk credit and a desk remove fired together]. A per-seed bias
/// (<c>PLAYERS_PROPERTY_BIAS</c> = <c>mixed</c> by default, <c>debt</c> or <c>balanced</c>) leans a
/// third of the seeds to withdrawals, deep debits and small top-ups — the shape that finds
/// first-come-first-served defects.
/// </para>
///
/// <para>
/// <b>Cost.</b> 150 seeds by default (the three regression seeds included); set
/// <c>PLAYERS_PROPERTY_SEEDS</c> to run more, <c>PLAYERS_PROPERTY_FIRST_SEED</c> to move the window.
/// A failure names the seed and the steps that led to it; <c>PLAYERS_PROPERTY_TRACE</c>=a file path
/// appends every seed's steps and answers there. <c>PLAYERS_PROPERTY_CONCURRENT_WEIGHT</c>=n (the
/// default weight is 1) leans every seed to the concurrent step, to hunt races under load.
/// </para>
/// </summary>
public sealed class PlayersPropertyHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
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
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
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
                // Opt-in: every seed's steps and answers, to see what the generator actually did.
                if (Environment.GetEnvironmentVariable("PLAYERS_PROPERTY_TRACE") is { Length: > 0 } trace)
                {
                    await File.AppendAllLinesAsync(trace, run.Log.Prepend($"== seed {seed}"));
                }
            }
        }
    }

    /// <summary>One seeded scenario: a club, its games, a random walk, and the checks after every step.</summary>
    private sealed class Scenario(TestWebAppFactory f, int seed)
    {
        private readonly Random _rng = new(seed);
        private PlayersClub _club = null!;
        private readonly List<Game> _games = [];

        /// <summary>Games dated older than the sweep's window (round 8): only its stamped-seat read reaches them.</summary>
        private readonly HashSet<Guid> _old = [];
        private bool _oldSqueezed;
        private decimal _organiserFloor;
        private int _spends;

        /// <summary>Steps queued to run next, one per step (a debt seed's squeeze).</summary>
        private readonly Queue<Func<Task<string>>> _script = new();

        /// <summary>Lean this seed to withdrawals, deep debits and small top-ups (see the class summary).</summary>
        private readonly bool _debt = (Environment.GetEnvironmentVariable("PLAYERS_PROPERTY_BIAS") ?? "mixed") switch
        {
            "debt" => true,
            "balanced" => false,
            _ => seed % 3 == 0,
        };

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

        private sealed record Game(Guid Id, List<(Guid Seat, Guid Who)> Partners);

        public async Task RunAsync()
        {
            _club = await PlayersClub.SeedAsync(f, $"prop{seed}");
            // 100 each: four games at up to 16 a share must fit (round 7 — seed 20087 ran out at 60).
            foreach (var who in Partners) await _club.CreditAsync(f, who, 100m);
            var games = _rng.Next(2, 5);
            for (var i = 0; i < games; i++) await AddGameAsync(i);
            Log.Add($"bias: {(_debt ? "debt" : "balanced")}");
            var pre = await CheckAsync("setup", null);

            var steps = _debt ? _rng.Next(10, 17) : _rng.Next(5, 10);
            for (var step = 0; step < steps; step++)
            {
                var what = await StepAsync();
                await SweepAsync();
                pre = await CheckAsync($"step {step}: {what}", pre);
            }

            // LIVENESS at the end: top up to exactly every earmark plus every pending return, and
            // nothing may be left pending.
            var short_ = pre.Earmarked + pre.Seats.Sum(s => s.Pending) - pre.Balance;
            if (short_ > 0m) await DeskAsync(short_, null, "top_up_cash");
            await SweepAsync();
            var end = await CheckAsync($"topped up by {Math.Max(0m, short_)}", pre);
            Assert.True(end.Seats.All(s => s.Pending == 0m && s.Seat.ReturnPendingSince is null),
                $"liveness: pending after topping up to earmarks + pending: {string.Join(",", end.Seats.Where(s => s.Pending > 0m).Select(s => $"{s.Seat.Id}={s.Pending}"))}");
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
            // Debt seeds spread the shares to the ends (4 or the most there is room for), so a big
            // return and a small one can wait side by side.
            var amounts = who.Select(_ => _debt ? (_rng.Next(2) == 0 ? 4m : most * 4m) : (decimal)_rng.Next(1, most + 1) * 4m).ToList();
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
            // Some played games are OLD (round 8): 10–40 days ago, deadline long passed, so the
            // minute sweep's window no longer reaches them — a return waiting on one is retried by
            // the sweep only through its read of stamped seats (the refuter's mutant D).
            var old = !s4 && _rng.NextDouble() < 0.35;
            if (old)
            {
                var daysAgo = 10 + (index * 9) + _rng.Next(0, 8);   // one 8-day band per game: no overlap
                await _club.WriteAsync(f, db =>
                {
                    var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == id);
                    var length = b.EndsAt - b.StartsAt;
                    b.StartsAt = b.StartsAt.AddDays(-daysAgo - 1);
                    b.EndsAt = b.StartsAt + length;
                    b.Status = BookingStatus.Completed;
                    b.ShareDeadlineAt = b.EndsAt.AddHours(48);
                });
                _old.Add(id);
            }
            _games.Add(new Game(id, who.Select((w, i) => (seats[i], w)).ToList()));
            Log.Add($"game {index}: {id} s4={s4} old={old} partners={string.Join(",", amounts)}");
        }

        // -------------------------------------------------------------- steps

        private async Task<string> StepAsync()
        {
            if (_script.Count > 0) return await _script.Dequeue()();
            if (!_oldSqueezed && _old.Count > 0 && _rng.NextDouble() < 0.5 && await OldSqueezeAsync() is { } squeezed) return squeezed;
            if (_debt && _rng.NextDouble() < 0.3)
            {
                // The squeeze, four steps, each checked on its own: the free balance thinned just
                // below zero; the biggest live share withdrawn after its game's deadline; the smallest
                // on ANOTHER game likewise — both returns need free money and both wait, the big one
                // first — then a top-up of 4 that covers the small one alone. First come, first
                // served says it still waits. (Round 7: the shape that catches the FCFS mutant.)
                _script.Enqueue(LateWithdrawAsync(biggest: true));
                _script.Enqueue(LateWithdrawAsync(biggest: false));
                _script.Enqueue(() => DeskAsync(4m, null, "top_up_cash"));
                return await DeskAsync(-await ThinDebitAsync(), null, "correction");
            }
            var game = _games[_rng.Next(_games.Count)];
            var (seat, who) = game.Partners[_rng.Next(game.Partners.Count)];
            // Balanced: every step alike. Debt: returns that must come from FREE money (games past
            // their deadline or cancelled after check-in) arising while older ones wait on a thin
            // balance — withdrawals, desk hand-backs, deep debits, small top-ups, late withdrawals.
            // Order: withdraw, organiser remove, desk remove, settle outside, cancel, goodwill,
            // top-up, debit, deadline, reconcile, spend, S4, lower, concurrent, late withdraw.
            int[] weights = _debt ? [3, 1, 2, 1, 1, 1, 5, 3, 1, 1, 1, 1, 1, 1, 5]
                                  : [2, 2, 2, 2, 1, 2, 2, 2, 1, 1, 2, 1, 2, 1, 1];
            // Opt-in, for hunting races (2026-09-30): lean every seed to the CONCURRENT step.
            if (int.TryParse(Environment.GetEnvironmentVariable("PLAYERS_PROPERTY_CONCURRENT_WEIGHT"), out var concurrent) && concurrent > 0)
            {
                weights[13] = concurrent;
            }
            var pick = _rng.Next(weights.Sum());
            var step = 0;
            while (pick >= weights[step]) pick -= weights[step++];
            switch (step)
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
                    return await DeskAsync(_debt ? _rng.Next(1, 3) * 4m : _rng.Next(1, 7) * 4m, null, "top_up_cash");
                case 7:
                    return await DeskAsync(-(_debt ? await ThinDebitAsync() : _rng.Next(1, 11) * 4m), null, "correction");
                case 8:
                    await _club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == game.Id).ShareDeadlineAt = DateTimeOffset.UtcNow.AddMinutes(-1));
                    return $"deadline passes on {game.Id}";
                case 9:
                    foreach (var g in _games.OrderBy(_ => _rng.Next()))
                    {
                        await _club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(g.Id, default));
                    }
                    return "reconcile every game, random order";
                case 10:
                    return await SpendAsync();
                case 11:
                    return await CheckInAndCancelAsync(game);
                case 12:
                    return await LowerAsync(game, seat);
                case 13:
                    return await ConcurrentlyAsync(game, seat);
                default:
                    await _club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == game.Id).ShareDeadlineAt = DateTimeOffset.UtcNow.AddMinutes(-1));
                    return "deadline passes, then " + await Status("withdraw", _club.Client(f, who).PostAsync($"/api/v1/bookings/{game.Id}/players/{seat}/withdraw", null));
            }
        }

        /// <summary>
        /// A debt seed's debit: enough to leave the FREE balance (balance less earmarks and what waits)
        /// just below zero, −4 to −20, so the small top-ups that follow walk it through the window where
        /// one waiting return is covered and an older, bigger one is not.
        /// </summary>
        private async Task<decimal> ThinDebitAsync()
        {
            var m = await ModelAsync();
            var free = m.Balance - m.Earmarked - m.OwedBack(m.Waiting());
            return Math.Max(4m, Math.Ceiling(free / 4m) * 4m + _rng.Next(1, 6) * 4m);
        }

        /// <summary>
        /// The old-game squeeze, four steps, each checked on its own (round 8): the free balance
        /// pushed to −24; a goodwill 16 naming an OLD game, whose pro-rata returns then wait; a
        /// top-up leaving the first waiting return short by less than a young game's hold; then that
        /// game's deadline passes. Its hold stops being earmarked, the waiting return is covered —
        /// and no credit arrived, so only the minute sweep's read of stamped seats can pay it.
        /// </summary>
        private async Task<string?> OldSqueezeAsync()
        {
            var m = await ModelAsync();
            var old = _games.FirstOrDefault(g => _old.Contains(g.Id) && m.Seats.Any(s => s.Seat.BookingId == g.Id && s.Paid > 0m));
            var young = _games.Where(g => !_old.Contains(g.Id) && m.EarmarkOf(g.Id) > 0m && !m.PastDeadline.Contains(g.Id))
                .OrderByDescending(g => m.EarmarkOf(g.Id)).FirstOrDefault();
            if (old is null || young is null) return null;
            _oldSqueezed = true;
            _script.Enqueue(() => DeskAsync(16m, old.Id, "goodwill"));
            _script.Enqueue(async () =>
            {
                var now = await ModelAsync();
                var first = now.Waiting().FirstOrDefault();
                if (first is null) return "old squeeze: nothing waits";
                var free = now.Balance - now.Earmarked;
                var topUp = first.Pending - now.EarmarkOf(young.Id) - free;
                return topUp > 0m ? await DeskAsync(topUp, null, "top_up_cash") : "old squeeze: no top-up needed";
            });
            _script.Enqueue(async () =>
            {
                await _club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == young.Id).ShareDeadlineAt = DateTimeOffset.UtcNow.AddMinutes(-1));
                return $"old squeeze: deadline passes on {young.Id}";
            });
            var debit = m.Balance - m.Earmarked - m.OwedBack(m.Waiting()) + 24m;
            return debit > 0m ? "old squeeze: " + await DeskAsync(-debit, null, "correction") : "old squeeze: already short";
        }

        /// <summary>
        /// A partner withdraws after the game's deadline (its hold released, so the return needs free
        /// money): the biggest live share of all games, or the smallest on a game other than the
        /// biggest's.
        /// </summary>
        private Func<Task<string>> LateWithdrawAsync(bool biggest) => async () =>
        {
            var live = new List<(Game Game, BookingParticipant Seat)>();
            foreach (var g in _games)
            {
                live.AddRange((await _club.SeatsAsync(f, g.Id)).Where(p => p.Seat > 1 && p.Status == ParticipantStatus.Accepted).Select(p => (g, p)));
            }
            if (live.Count == 0) return "late withdraw: nobody left";
            var ordered = live.OrderByDescending(x => x.Seat.ShareCredits).ToList();
            var pick = biggest ? ordered[0] : ordered.Where(x => x.Game.Id != ordered[0].Game.Id).DefaultIfEmpty(ordered[^1]).Last();
            await _club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == pick.Game.Id).ShareDeadlineAt = DateTimeOffset.UtcNow.AddMinutes(-1));
            return $"late withdraw ({(biggest ? "biggest" : "smallest")} {pick.Seat.ShareCredits}): " + await Status("withdraw",
                _club.Client(f, pick.Seat.UserId!.Value).PostAsync($"/api/v1/bookings/{pick.Game.Id}/players/{pick.Seat.Id}/withdraw", null));
        };

        /// <summary>The organiser buys a court on a free day: allowed exactly when the model's spendable covers it.</summary>
        private async Task<string> SpendAsync()
        {
            var m = await ModelAsync();
            var slices = _rng.Next(1, 3);
            var price = 8m * slices;
            var day = PlayersClub.Tomorrow(12).AddDays(4 + (_spends++ % 8));
            var response = await Organiser.PostAsJsonAsync("/api/v1/bookings", new { courtId = _club.CourtId, startsAt = day, sliceCount = slices });
            var text = await response.Content.ReadAsStringAsync();
            var allowed = m.Spendable >= price;
            Assert.True(response.StatusCode is HttpStatusCode.OK or HttpStatusCode.PaymentRequired or HttpStatusCode.Conflict,
                $"spend {price}: {(int)response.StatusCode} {text}");
            if (response.StatusCode != HttpStatusCode.Conflict)
            {
                Assert.True(allowed == response.IsSuccessStatusCode, $"spend {price}: model spendable {m.Spendable} but {(int)response.StatusCode} {text}");
            }
            return $"spend {price} (spendable {m.Spendable}) -> {(int)response.StatusCode}";
        }

        /// <summary>A live game is checked into and cancelled: it becomes S4 mid-run.</summary>
        private async Task<string> CheckInAndCancelAsync(Game game)
        {
            await _club.WriteAsync(f, db =>
            {
                var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == game.Id);
                if (b.Status == BookingStatus.Booked) b.CheckedInAt = DateTimeOffset.UtcNow;
            });
            return await Status("check-in + cancel", Organiser.PostAsJsonAsync($"/api/v1/bookings/{game.Id}/cancel", new { }));
        }

        /// <summary>The organiser lowers one live partner's share by 4, naming every live seat's figure.</summary>
        private async Task<string> LowerAsync(Game game, Guid seat)
        {
            var live = (await _club.SeatsAsync(f, game.Id)).Where(p => p.Seat > 1 && p.IsLive).ToList();
            if (!live.Any(p => p.Id == seat && p.ShareCredits >= 8m)) return "lower: nothing to lower";
            var response = await Organiser.PutAsJsonAsync($"/api/v1/bookings/{game.Id}/split", new
            {
                mode = "amount",
                seats = live.Select(p => new { participantId = p.Id, amount = p.Id == seat ? p.ShareCredits - 4m : p.ShareCredits }).ToArray(),
            });
            return await Status($"lower {seat} by 4", Task.FromResult(response));
        }

        /// <summary>
        /// Every game's reconcile, a sweep, a desk credit and a desk remove, fired together. The
        /// desk's answer is not held to the pre-check here — a race may leave it waiting, and the
        /// answer then says so; the invariants after it still hold.
        /// </summary>
        private async Task<string> ConcurrentlyAsync(Game game, Guid seat)
        {
            var work = new List<Task>();
            work.AddRange(_games.Select(g => (Task)_club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(g.Id, default))));
            work.Add(SweepAsync());
            var credit = Admin.PostAsJsonAsync($"/api/v1/admin/credit/{_club.Organiser}/adjust",
                new { amountCredits = _rng.Next(1, 6) * 4m, reason = "property step", reasonCode = "top_up_cash", zarReceived = 10m });
            var remove = Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{game.Id}/players/{seat}/remove", new { reason = "property step" });
            work.Add(credit);
            work.Add(remove);
            await Task.WhenAll(work);
            foreach (var answer in new[] { await credit, await remove })
            {
                Assert.True((int)answer.StatusCode < 500, $"concurrently: {(int)answer.StatusCode} {await answer.Content.ReadAsStringAsync()}");
            }
            return $"concurrently: every reconcile + sweep + desk credit ({(int)(await credit).StatusCode}) + desk remove ({(int)(await remove).StatusCode})";
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
                new { amountCredits = amount, reason = "property step", reasonCode = code, relatedBookingId = booking, zarReceived = 10m });
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

        private async Task<Model> CheckAsync(string after, Model? pre)
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

            // LIVENESS: a balance covering every earmark and every pending return leaves nothing waiting.
            if (m.Balance >= m.Earmarked + m.Seats.Sum(s => s.Pending))
            {
                Assert.True(queue.Count == 0, $"{after}: {queue.Count} return(s) wait though the balance {m.Balance} covers earmarks {m.Earmarked} + pending {m.Seats.Sum(s => s.Pending)}");
            }

            // No return row ever took the running balance below zero.
            var running = 0m;
            foreach (var group in m.OrganiserRows.GroupBy(l => l.CreatedAt).OrderBy(g => g.Key))
            {
                running += group.Sum(l => l.AmountCredits);
                var returned = group.Where(l => l.Type == LedgerEntryType.ShareTransfer && l.AmountCredits < 0m).ToList();
                Assert.True(returned.Count == 0 || running >= 0m, $"{after}: a return at {group.Key:O} left the organiser on {running}");
            }

            if (pre is not null) CheckFirstComeFirstServed(after, pre, m);
            return m;
        }

        /// <summary>
        /// No return made during the step drew on money beyond its own game's earmark (less what
        /// earlier returns needed there) while a return stamped BEFORE the step still waits after it.
        /// </summary>
        private static void CheckFirstComeFirstServed(string after, Model pre, Model post)
        {
            var stillWaiting = pre.Waiting().Where(w => post.Seats.Any(s => s.Seat.Id == w.Seat.Id && s.Seat.ReturnPendingSince is not null)).ToList();
            if (stillWaiting.Count == 0) return;
            foreach (var before in pre.Seats)
            {
                var now = post.Seats.Single(s => s.Seat.Id == before.Seat.Id);
                var returned = before.Paid - now.Paid;
                if (returned <= 0m) continue;
                var earlier = stillWaiting.Where(w => w.Seat.Id != before.Seat.Id
                    && (before.Seat.ReturnPendingSince is null
                        || w.Seat.ReturnPendingSince < before.Seat.ReturnPendingSince
                        || (w.Seat.ReturnPendingSince == before.Seat.ReturnPendingSince && w.Seat.Id.CompareTo(before.Seat.Id) < 0))).ToList();
                if (earlier.Count == 0) continue;
                // The game's earmark as it stood — nothing, if the step itself released it (the
                // deadline passed) or turned the game S4.
                var game = before.Seat.BookingId;
                var earmark = post.PastDeadline.Contains(game) || post.AfterCheckIn.Contains(game) ? 0m : pre.EarmarkOf(game);
                var ownEarmark = Math.Max(0m, earmark - earlier.Where(e => e.Seat.BookingId == game).Sum(e => e.Pending));
                Assert.True(returned <= ownEarmark,
                    $"{after}: seat {before.Seat.Id} was paid {returned} beyond its game's earmark {ownEarmark} while {earlier.Count} earlier return(s) still wait");
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
            public List<LedgerEntry> OrganiserRows { get; init; } = [];
            public HashSet<Guid> PastDeadline { get; init; } = [];

            /// <summary>Every earmark: the holds of games not cancelled after check-in.</summary>
            public decimal Earmarked => Holds.Keys.Sum(EarmarkOf);

            /// <summary>What the organiser may spend: balance less every hold and every waiting return's owed-back.</summary>
            public decimal Spendable => Balance - Holds.Values.Sum() - OwedBack(Waiting());

            /// <summary>Waiting returns, first come first served: stamp, then participant id.</summary>
            public List<SeatRow> Waiting() => Seats.Where(s => s.Seat.ReturnPendingSince is not null)
                .OrderBy(s => s.Seat.ReturnPendingSince).ThenBy(s => s.Seat.Id).ToList();

            public decimal EarmarkOf(Guid booking) => AfterCheckIn.Contains(booking) ? 0m : Holds.GetValueOrDefault(booking);

            public decimal OwedBack(IEnumerable<SeatRow> waiting) =>
                waiting.GroupBy(w => w.Seat.BookingId).Sum(g => Math.Max(0m, g.Sum(w => w.Pending) - Holds.GetValueOrDefault(g.Key)));

            /// <summary>§3's coverage, recomputed here from raw rows.</summary>
            public decimal Coverage(Guid booking, Guid seat, IEnumerable<SeatRow> earlier)
            {
                var need = earlier.Where(e => e.Seat.Id != seat).GroupBy(e => e.Seat.BookingId).ToDictionary(g => g.Key, g => g.Sum(e => e.Pending));
                var drawn = need.Sum(kv => Math.Min(kv.Value, EarmarkOf(kv.Key)));
                var excess = need.Sum(kv => Math.Max(0m, kv.Value - EarmarkOf(kv.Key)));
                var earmarked = Holds.Keys.Sum(EarmarkOf);
                var mine = Math.Max(0m, EarmarkOf(booking) - need.GetValueOrDefault(booking));
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
                OrganiserRows = rows.Where(l => l.UserId == organiser).ToList(),
                PastDeadline = bookings.Where(b => now >= PlayerSettings.ShareDeadline(b, settings)).Select(b => b.Id).ToHashSet(),
            };
        }
    }
}
