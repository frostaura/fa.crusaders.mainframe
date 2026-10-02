using System.Text.Json;
using System.Threading.Channels;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static partial class WalletEndpoints
{
    /// <summary>
    /// <c>GET /wallet</c>'s query string. <c>include=share_bookings</c> (perf round, 2026-09-30) adds
    /// a summary of every booking this page's share rows name, keyed by booking id — what the
    /// Wallet page had fetched with one <c>GET /bookings/{id}</c> per booking. Absent, the field is
    /// null and nothing is read for it.
    /// </summary>
    public sealed record WalletQuery(int? Limit, int? Offset, string? Include);

    private static async Task<Dictionary<Guid, object?>?> ShareBookingsAsync(
        WalletQuery query, IReadOnlyCollection<LedgerEntry> entries, HttpContext ctx, PlayersQuery players, CancellationToken ct)
    {
        if (!string.Equals(query.Include, "share_bookings", StringComparison.OrdinalIgnoreCase)) return null;
        var ids = entries
            .Where(e => e.Type == LedgerEntryType.ShareTransfer && e.RelatedBookingId is not null)
            .Select(e => e.RelatedBookingId!.Value)
            .ToList();
        return await players.ShareSummariesAsync(ids, ctx.User.Id() ?? Guid.Empty, ctx.User.IsInRole("admin"), ct);
    }

    public static IEndpointRouteBuilder MapWalletEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1").RequireAuthorization();

        // limit/offset are bounded rather than optional. This returned EVERY ledger row the
        // member had ever had — DateTimeOffset.MinValue to now+1d with no Take — which is
        // fine at 32 rows and is three years of movements on a page a member opens on a
        // phone while arguing about their balance. The balance itself is still the full sum,
        // never the sum of the page.
        g.MapGet("/wallet", async ([AsParameters] WalletQuery query, HttpContext ctx, LedgerService ledger, MainframeDbContext db, PlayersQuery players, CancellationToken ct) =>
        {
            var (limit, offset) = (query.Limit, query.Offset);
            var userId = ctx.User.Id() ?? Guid.Empty;
            var take = Math.Clamp(limit ?? 100, 1, 500);
            var skip = Math.Max(offset ?? 0, 0);
            var balance = await ledger.GetBalanceAsync(userId, ct);
            var held = await ledger.GetHeldAsync(userId, ct);
            var total = await db.LedgerEntries.CountAsync(l => l.UserId == userId, ct);
            var entries = await ledger.GetEntriesAsync(userId, DateTimeOffset.MinValue, DateTimeOffset.UtcNow.AddDays(1), ct, skip, take);

            // Resolve display names so rows read with the same from/to/amount/time/comment shape
            // as the admin ledger.
            //
            // D2-B20: both reads carried IgnoreQueryFilters, on a MEMBER-facing route. The id set
            // includes e.ActorUserId, and LedgerService copies whatever a posting carries with no
            // tenant check — so any row whose actor was not in this tenant rendered that foreign
            // user's full name and email to a member. A deliberate filter bypass on a
            // member-facing route is exactly what MainframeDbContext's own comment says must not
            // exist, and nothing here needed it: an actor in another club has no name this club
            // is entitled to show, and "(unknown)" is the honest answer.
            var ids = entries.Select(e => e.UserId).Concat(entries.Select(e => e.ActorUserId)).Distinct().ToList();
            var nameByUserId = await db.Memberships.AsNoTracking()
                .Where(m => ids.Contains(m.UserId))
                .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);
            var emailByUserId = await db.Users.AsNoTracking()
                .Where(u2 => ids.Contains(u2.Id))
                .ToDictionaryAsync(u2 => u2.Id, u2 => u2.Email, ct);
            string nameFor(Guid id) => nameByUserId.TryGetValue(id, out var n) ? n
                : emailByUserId.TryGetValue(id, out var em) ? em
                : "(unknown)";

            var admins = await LedgerRowMapper.AdminsAsync(db, ids, ct);
            var counterparties = await LedgerRowMapper.ShareCounterpartiesAsync(db, entries, ct);
            var rows = entries.Select(e => LedgerRowMapper.Build(e, nameFor, admins.Contains, counterparties)).ToList();
            var shareBookings = await ShareBookingsAsync(query, entries, ctx, players, ct);

            return Results.Ok(new
            {
                balance_minutes = balance,
                // D11: shares received as an organiser, held for the partners' possible returns
                // until the earliest share deadline among them (ShareHolds). Part of the balance,
                // not spendable — every booking and payment checks spendable_minutes.
                held_minutes = held.Held,
                owed_back_minutes = held.OwedBack,
                spendable_minutes = balance - held.Reserved,
                held_until = held.ReleasesAt,
                // C4: one part per share deadline, soonest first, summing to held_minutes; held_until is the first.
                held_parts = held.WireParts(),
                entries = rows,
                total_entries = total,
                offset = skip,
                limit = take,
                share_bookings = shareBookings,
            });
        });

        // Mints the credential the SSE stream is opened with.
        //
        // EventSource cannot set an Authorization header, so whatever authenticates the stream has
        // to ride in the URL — and nginx's `location /api/` logs `$request`, query string included,
        // on every connect and every reconnect. The full access token used to travel there: a
        // fifteen-minute credential for the entire API, written to a log file that outlives it by
        // months. This ticket is minted by a POST (never logged), lives one minute, and is refused
        // on every path but the stream itself.
        g.MapPost("/wallet/stream-ticket", MintStreamTicket);

        // Server-Sent Events stream of the current user's balance. Pushes the latest balance
        // whenever any ledger entry posts for this user. Used by the BalanceProvider on the
        // client so admin top-ups land in the member's session without a reload.
        g.MapGet("/wallet/stream", StreamAsync);

        // Admin: the desk moving a member's minutes by hand (P13 §3.7) — an adjustment, a package
        // sold over the counter, and the member's shelf for the sale. The only routes in the API
        // that move money by hand, and the only limiter on them was the global 600/min per IP. A
        // desk that can be scripted is a desk that can be drained — so they are bounded per admin,
        // by `writes` (a flood bound) rather than `auth` (a guessing bound): the desk serving a
        // queue of members at the counter is not guessing.
        var admin = app.MapGroup("/api/v1/admin/minutes")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .RequireRateLimiting(Security.RateLimitPolicies.Writes);

        // The handler is a named method rather than an inline lambda: it is the most
        // consequential route in this file - it moves a member's balance by hand - and
        // inline it pushed MapWalletEndpoints past the complexity gate, where the reported
        // number belongs to no single decision anybody could reason about.
        admin.MapPost("/{userId:guid}/adjust", AdjustAsync);
        admin.MapPost("/{userId:guid}/sell", SellAsync);
        admin.MapGet("/{userId:guid}/packages", DeskShelfAsync);

        return app;
    }

    /// <summary>
    /// The member's own live balance, as Server-Sent Events.
    ///
    /// <para>
    /// A named method rather than an inline lambda for the reason the adjust handler already
    /// gives: lizard scores the whole <c>MapWalletEndpoints</c> registration as one function, so
    /// a handler's branches are charged to the registration.
    /// </para>
    ///
    /// <para>
    /// <b>Two frames per movement.</b> <see cref="LedgerService"/> publishes the legacy unnamed
    /// <c>data:</c> frame that today's client listens for as <c>message</c>, and a named
    /// <c>balance</c> frame carrying <c>delta_minutes</c> and <c>reason</c> beside it. The
    /// stream itself is a transport and does not know the difference: it writes whatever the bus
    /// hands it, so a third frame shape costs nothing here.
    /// </para>
    ///
    /// <para>
    /// The opening frame is still the plain balance, because a client that has just connected
    /// has no delta to animate — it has a number to show.
    /// </para>
    /// </summary>
    /// <summary>
    /// The opening frame: the balance, plus (D11) what of it is held for the member's partners
    /// and until when — additive fields, so a client that reads only <c>balance_minutes</c> is
    /// unchanged.
    /// </summary>
    private static async Task<string> OpeningFrameAsync(LedgerService ledger, Guid userId, CancellationToken ct)
    {
        var balance = await ledger.GetBalanceAsync(userId, ct);
        var held = await ledger.GetHeldAsync(userId, ct);
        return JsonSerializer.Serialize(new
        {
            balance_minutes = balance,
            held_minutes = held.Held,
            owed_back_minutes = held.OwedBack,
            spendable_minutes = balance - held.Reserved,
            held_until = held.ReleasesAt,
            // C4: one part per share deadline, soonest first, summing to held_minutes; held_until is the first.
            held_parts = held.WireParts(),
        });
    }

    private static async Task StreamAsync(
        HttpContext ctx,
        LedgerService ledger,
        IRealtimeBus bus,
        ITenantContext tenant,
        TenantSettingsAccessor settings,
        CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) { ctx.Response.StatusCode = 401; return; }

        ctx.Response.Headers["Content-Type"] = "text/event-stream";
        ctx.Response.Headers["Cache-Control"] = "no-cache, no-transform";
        ctx.Response.Headers["Connection"] = "keep-alive";
        // nginx defaults buffer proxied responses; this header disables that for SSE.
        ctx.Response.Headers["X-Accel-Buffering"] = "no";

        // The club's own keep-alive, clamped. RealtimeSettings is where the relationship between
        // this number and nginx's unset-and-therefore-60-second proxy_read_timeout is written
        // down, and why the ceiling is 55 rather than a round minute.
        var keepAlive = KeepAliveOverride ?? RealtimeSettings.KeepAlive(await settings.GetAsync(ct));
        var topic = RealtimeTopic.Wallet(tenant.TenantId, userId);

        Channel<RealtimeMessage>? channel = null;
        try
        {
            channel = await SseStream.SubscribeThenSendAsync(
                bus, topic,
                async () => await WriteFrameAsync(
                    ctx,
                    new RealtimeMessage(
                        string.Empty,
                        await OpeningFrameAsync(ledger, userId, ct)),
                    ct));

            // The session is re-asked before every frame and keep-alive: a rotation (member-code
            // §10) ends every session, and a wallet stream opened under one must close with it.
            var epochs = ctx.RequestServices.GetRequiredService<SessionEpochs>();
            var principal = ctx.User;
            var services = ctx.RequestServices;
            var guard = new SseGuard(keepAlive, token => epochs.StillCurrentAsync(principal, services, token));
            await SseStream.PumpAsync(
                channel.Reader,
                keepAlive,
                async (frame, token) =>
                {
                    await SseStream.RequireAllowedAsync(guard, token);
                    await WriteFrameAsync(ctx, frame, token);
                },
                async token =>
                {
                    await SseStream.RequireAllowedAsync(guard, token);
                    await WriteKeepAliveAsync(ctx, token);
                },
                ct);
        }
        catch (StreamRevokedException) { /* the session was ended by a rotation */ }
        catch (OperationCanceledException) { /* client disconnect */ }
        finally
        {
            if (channel is not null) bus.Unsubscribe(topic, channel);
        }
    }

    /// <summary>Mints the one-minute, stream-scoped credential the SSE connection is opened with.</summary>
    /// <remarks>
    /// Named rather than inline for the same reason as <c>SignOutAsync</c>: lizard scores the
    /// whole <c>MapWalletEndpoints</c> registration as a single function, so a handler's branches
    /// are charged to the registration.
    /// </remarks>
    private static IResult MintStreamTicket(HttpContext ctx, IJwtIssuer jwt, ITenantContext tenant)
    {
        var userId = ctx.User.Id();
        if (userId is null) return Results.Unauthorized();
        var ticket = jwt.IssueOneTime(userId.Value, tenant.TenantId, tenant.TenantSlug,
            new TicketScope(TokenPurposes.WalletStream, TokenPurposes.WalletStreamTicketTtl), SessionEpochs.EpochOf(ctx.User));
        ticket = RefreshSessions.BindTicket(jwt, ctx.User, ticket);
        return Results.Ok(new
        {
            ticket,
            expires_in_seconds = (int)TokenPurposes.WalletStreamTicketTtl.TotalSeconds,
        });
    }

    /// <summary>
    /// The largest adjustment the desk may type, either way (P13 §3.7).
    ///
    /// <para>
    /// The amount binds as a <c>long</c> so a typo of twelve digits is refused by name here,
    /// <c>amount_out_of_range</c> with the bound, instead of failing to bind into an <c>int</c>
    /// with an empty 400 the console cannot word. A fraction of a minute still fails binding: the
    /// ledger holds whole minutes and nothing rounds one silently.
    /// </para>
    /// </summary>
    internal const int MaxAdjustmentMinutes = 999_999;

    /// <summary>The refusal for an amount the desk may not post, or null when it may.</summary>
    internal static IResult? RefuseAmount(long amountMinutes)
    {
        if (amountMinutes == 0) return Results.BadRequest(new { error = "amount_zero" });
        if (Math.Abs(amountMinutes) > MaxAdjustmentMinutes)
            return Results.BadRequest(new { error = "amount_out_of_range", max_minutes = MaxAdjustmentMinutes });
        return null;
    }

    /// <summary>
    /// An admin adjusting a member's minutes by hand — goodwill and corrections. A package sold
    /// at the desk is <see cref="SellAsync"/>.
    ///
    /// <para>
    /// Idempotent when the caller names the movement. See <see cref="IdempotencyReference"/>
    /// for why the reference carries the tenant, and <c>AdminCreditAdjustHttpTests</c> for
    /// what a double-clicked Apply button used to do to the ledger. The adjustment may take a
    /// balance below zero, as it always could (P13 §12.8).
    /// </para>
    /// </summary>
    private static async Task<IResult> AdjustAsync(
        Guid userId, AdjustRequest req, HttpContext ctx,
        [AsParameters] AdjustServices services,
        CancellationToken ct)
    {
        var logger = services.LoggerFactory.CreateLogger("MinutesAdjustment");

        if (RefuseAmount(req.AmountMinutes) is { } badAmount) return badAmount;
        if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
        if (AdminCreditReasons.ResolveAdjustment(req.ReasonCodeEither, logger) is not { } kind)
        {
            return Results.BadRequest(new { error = "reason_code_invalid", valid = AdminCreditReasons.AdjustmentCodes });
        }

        var reference = IdempotencyReference(services.Tenant.TenantId, req.IdempotencyKey);
        if (reference is { Length: 0 }) return Results.BadRequest(new { error = "idempotency_key_invalid" });
        if (!await services.Db.Users.AnyAsync(u => u.Id == userId, ct)) return Results.NotFound();
        if (await RefuseRelatedBooking(services.Db, userId, req.RelatedBookingId, ct) is { } badBooking) return badBooking;

        var movement = new DeskMovement(userId, kind, (int)req.AmountMinutes, null, req.Reason, req.Reason)
        {
            RelatedBookingId = req.RelatedBookingId,
            IdempotencyKey = req.IdempotencyKey,
            Reference = reference,
        };
        return await MoveAsync(movement, ctx, services, ct);
    }

    /// <summary>
    /// Posts one desk movement — an adjustment or a sale — idempotently, records it, mails the
    /// member and answers. 404 for a member this club does not have.
    /// </summary>
    private static async Task<IResult> MoveAsync(
        DeskMovement movement, HttpContext ctx, AdjustServices services, CancellationToken ct)
    {
        var db = services.Db;
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == movement.UserId, ct);
        if (user is null) return Results.NotFound();

        var balanceBefore = await services.Ledger.GetBalanceAsync(movement.UserId, ct);

        // A double-click on the desk's Apply button posted the movement twice, and a slow club
        // connection with four impatient clicks posted it four times: 44 minutes granted where
        // 11 were typed. Money is ledger-only, so a duplicated row IS the wrong balance, and
        // there is nothing on the ledger to say which of the identical rows was the mistake.
        if (movement.Reference is { } key && await ExistingAdjustmentAsync(db, key, ct) is { } already)
        {
            return Replay(already, movement, balanceBefore, user);
        }

        // One unit of work for the money AND its record. See PostAndRecordAsync.
        var (posted, raced) = await PostAndRecordAsync(movement, ctx, services, ct);
        if (posted is null)
        {
            // The lookup above loses the race when both clicks are in flight at once, which is
            // exactly what a double-click produces. The unique filtered index on
            // ExternalReference is what actually holds the line; this turns its violation into
            // the same answer the first request got. The transaction has already rolled back, so
            // the re-read runs on a clean connection.
            db.ChangeTracker.Clear();
            var twin = await ExistingAdjustmentAsync(db, movement.Reference!, ct);
            if (twin is null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(raced!);
            return Replay(twin!, movement, balanceBefore, user);
        }

        // D11: an adjustment naming a booking moves the organiser's Owed, so the partners' shares
        // follow — here, after the commit, however old the booking is. The hook never throws.
        if (movement.RelatedBookingId is { } adjustedBooking) await ctx.AfterSettlementAsync([adjustedBooking], ct);

        // "Every player-affecting event sends an email" — and an admin moving a member's balance
        // by hand is about as player-affecting as it gets. Background dispatch: an admin is
        // waiting on this form and SMTP is not what decides whether the movement stands.
        Crusaders.Mainframe.Api.Email.EmailDispatch.InBackground(
            services.Email, services.LoggerFactory.CreateLogger("MinutesAdjustment"),
            await DeskMailAsync(movement, user.Email, posted, services, ct),
            $"desk minutes movement {posted.Entry.Id}");

        return MovementResult(posted.Entry, movement, posted.BalanceBefore, posted.BalanceAfter, user);
    }

    /// <summary>The member's mail for a desk movement: a package sold, or minutes adjusted (P13 §6).</summary>
    private static async Task<Crusaders.Mainframe.Api.Email.EmailMessage> DeskMailAsync(
        DeskMovement movement, string to, AdjustmentPosted posted, AdjustServices services, CancellationToken ct)
    {
        var club = await services.Club.GetAsync(ct);
        if (movement.Package is { } item)
        {
            var symbol = CurrencySymbol.For(await services.Settings.GetAsync(ct));
            return Crusaders.Mainframe.Api.Email.EmailTemplates.PackageSoldAtDesk(club, to, new Crusaders.Mainframe.Api.Email.DeskPackageSale(
                item.Package.Name, item.Package.Minutes, posted.Entry.ZarPaid ?? 0m, posted.BalanceAfter, symbol));
        }
        return Crusaders.Mainframe.Api.Email.EmailTemplates.MinutesAdjusted(
            club, to, posted.Entry.AmountMinutes, posted.BalanceAfter, movement.GivenReason);
    }

    /// <summary>
    /// The by-hand movement, its <c>audit_log</c> row and its <c>admin_change_log</c> row, as ONE
    /// unit of work under the payer's lock.
    ///
    /// <para>
    /// <see cref="LedgerService.PostAsync"/> saves on its own, so posting first and recording
    /// second was two commits: a record that failed to save — or a request aborted between the
    /// two, which is what a desk closing the tab does — left the money moved with no audit row,
    /// no change-log row and no email, and answered 500. The admin then retried, and without an
    /// idempotency key the retry credited the member again. Now the post joins a transaction the
    /// lock owns, the two records flush beside it, and a failure anywhere rolls all three back —
    /// the ledger never holds a by-hand movement the club's record cannot show.
    /// </para>
    ///
    /// <para>
    /// The lock is <see cref="PayerLock"/>, the same one a booking takes on this wallet, so the
    /// two balances in the record are read where nothing else can move them, and the live
    /// balance frame waits for the commit (D2-B07). Returns the exception instead of a result
    /// when the post lost an idempotency race, AFTER the transaction has rolled back, so the
    /// caller can re-read on a clean connection.
    /// </para>
    /// </summary>
    private static async Task<(AdjustmentPosted? Posted, DbUpdateException? Raced)> PostAndRecordAsync(
        DeskMovement m, HttpContext ctx, AdjustServices services, CancellationToken ct)
    {
        var (ledger, db, tenant) = (services.Ledger, services.Db, services.Tenant);
        var actorId = ctx.User.Id() ?? Guid.Empty;

        await using var payerLock = await PayerLock.BeginAsync(db, tenant.TenantId, m.UserId, services.Outbox, ct);
        var balanceBefore = await ledger.GetBalanceAsync(m.UserId, ct);

        LedgerEntry entry;
        try
        {
            entry = await ledger.PostAsync(new LedgerPosting(
                UserId: m.UserId,
                Type: m.Kind.Type,
                AmountMinutes: m.AmountMinutes,
                ActorUserId: actorId,
                // Naming the booking is what nets this adjustment, per leg, against a late
                // box upload's automatic reversal of the same no-show, instead of correcting
                // the member twice. See BookingService.SettledLegsAsync and the settlement
                // model's I3/I4.
                RelatedBookingId: m.RelatedBookingId,
                Reason: m.LedgerReason,
                ExternalReference: m.Reference,
                // B7: the rand the desk took, on a sale only — what the revenue report sums.
                ZarPaid: m.ZarPaid), ct);
        }
        catch (DbUpdateException ex) when (m.Reference is not null)
        {
            return (null, ex);
        }

        var balanceAfter = await ledger.GetBalanceAsync(m.UserId, ct);
        db.AuditLogs.Add(DeskAudit(m, entry, (balanceBefore, balanceAfter), ctx));

        // The club's undeletable record. A sale files as credit.topped_up because it counts as
        // revenue and a club reads the two differently; every other code is an adjustment. Both
        // require a reason, which both routes already demand. The codes keep "credit" (P13 §2.5).
        await services.Changes.StageAsync(new AdminChange(
            Action: m.Kind.Type == LedgerEntryType.AdminTopUp
                ? AdminChangeActions.PackageSold
                : AdminChangeActions.MinutesAdjusted,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: m.UserId,
            SubjectLabel: PersonNames.Of(m.UserId, await PersonNames.ForAsync(db, [m.UserId], ct)),
            Reason: m.GivenReason,
            Before: new { balance_minutes = balanceBefore },
            After: DeskChangeAfter(m, entry, balanceAfter)), ct);
        await db.SaveChangesAsync(ct);
        await payerLock.CommitAsync(ct);

        return (new AdjustmentPosted(entry, balanceBefore, balanceAfter), null);
    }

    /// <summary>
    /// D2-B08: the by-hand movement on the club's audit trail, with the two balances it moved
    /// between — an adjustment is only reviewable if the row says where it took the member FROM
    /// and TO. A sale adds the package it sold (P13 §3.7).
    /// </summary>
    private static Domain.AuditLog DeskAudit(DeskMovement m, LedgerEntry entry, (int Before, int After) balance, HttpContext ctx)
    {
        var details = new Dictionary<string, object?>
        {
            ["user_id"] = m.UserId,
            ["entry_id"] = entry.Id,
            ["entry_type"] = m.Kind.Type.ToString(),
            ["amount_minutes"] = m.AmountMinutes,
            ["reason"] = m.GivenReason,
            ["reason_code"] = m.Kind.Code,
            ["zar_received"] = entry.ZarPaid,
            ["balance_before_minutes"] = balance.Before,
            ["balance_after_minutes"] = balance.After,
            ["related_booking_id"] = m.RelatedBookingId,
            ["idempotency_key"] = m.IdempotencyKey,
        };
        if (m.Package is { } item)
        {
            details["package_id"] = item.Package.Id;
            details["package_name"] = item.Package.Name;
            details["minutes"] = item.Package.Minutes;
        }

        return new Domain.AuditLog
        {
            TenantId = entry.TenantId,
            ActorUserId = ctx.User.Id() ?? Guid.Empty,
            SubjectUserId = m.UserId,
            Action = AdminCreditReasons.AuditAction,
            IpAddress = ctx.Connection.RemoteIpAddress?.ToString(),
            UserAgent = ctx.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua : null,
            DetailsJson = JsonSerializer.Serialize(details),
        };
    }

    /// <summary>
    /// The change record's after side: the adjust shape, plus the package's id and name on a sale.
    /// </summary>
    private static Dictionary<string, object?> DeskChangeAfter(DeskMovement m, LedgerEntry entry, int balanceAfter)
    {
        var after = new Dictionary<string, object?>
        {
            ["balance_minutes"] = balanceAfter,
            ["amount_minutes"] = m.AmountMinutes,
            ["reason_code"] = m.Kind.Code,
            ["zar_received"] = entry.ZarPaid,
            ["entry_id"] = entry.Id,
            ["related_booking_id"] = m.RelatedBookingId,
        };
        if (m.Package is { } item)
        {
            after["package_id"] = item.Package.Id;
            after["package_name"] = item.Package.Name;
        }
        return after;
    }

    /// <summary>
    /// One desk movement, resolved and validated: who, what kind, how many minutes, the rand on a
    /// sale, the ledger's reason and the reason the admin typed. Bundled for the parameter gate.
    /// </summary>
    private sealed record DeskMovement(
        Guid UserId, AdminCreditReasons.Kind Kind, int AmountMinutes, decimal? ZarPaid, string LedgerReason, string GivenReason)
    {
        public Guid? RelatedBookingId { get; init; }
        public string? IdempotencyKey { get; init; }
        public string? Reference { get; init; }

        /// <summary>The package sold, on a sale; null on an adjustment.</summary>
        public ShelfItem? Package { get; init; }
    }

    /// <summary>A committed by-hand movement and the two balances it moved between.</summary>
    private sealed record AdjustmentPosted(LedgerEntry Entry, int BalanceBefore, int BalanceAfter);

    /// <summary>
    /// What a reused idempotency key answers.
    ///
    /// <para>
    /// <b>D2-B10.</b> The replay matched on <c>ExternalReference</c> alone and compared nothing
    /// else, so adjusting +11 with key <c>k1</c> and then +110 with <c>k1</c> answered 200 with
    /// the 11. A console that mints one key per FORM SESSION rather than per INTENDED MOVEMENT
    /// therefore silently discarded a corrected amount — and the admin was told it had been
    /// applied. A matching payload replays; a changed one is <c>409 idempotency_key_reused</c>
    /// carrying what is actually stored.
    /// </para>
    /// </summary>
    private static IResult Replay(LedgerEntry stored, DeskMovement m, int balanceBefore, Domain.User user)
    {
        var same = stored.AmountMinutes == m.AmountMinutes
                && stored.Type == m.Kind.Type
                && stored.RelatedBookingId == m.RelatedBookingId
                && stored.ZarPaid == m.ZarPaid;

        if (!same)
        {
            return Results.Json(new
            {
                error = "idempotency_key_reused",
                stored = new
                {
                    amount_minutes = stored.AmountMinutes,
                    type = stored.Type.ToString(),
                    reason = stored.Reason,
                    at = stored.CreatedAt,
                },
            }, statusCode: StatusCodes.Status409Conflict);
        }

        // The stored movement already happened, so the balance it left behind is the one before
        // it plus itself — read back rather than recomputed, so a replay quotes the same pair the
        // original did.
        return MovementResult(stored, m, balanceBefore - stored.AmountMinutes, balanceBefore, user);
    }

    /// <summary>
    /// The prefix that keeps a desk movement's idempotency key out of the payment
    /// gateway's namespace. <c>ledger_entries.ExternalReference</c> is uniquely indexed
    /// across every row, and a purchase already stores a PayFast transaction id there.
    /// </summary>
    internal const string AdjustmentReferencePrefix = "adjust:";

    /// <summary>
    /// The <c>ExternalReference</c> a supplied idempotency key maps to: <c>null</c> when the
    /// caller sent none (the old behaviour, still allowed for anything posting by hand),
    /// and the empty string when they sent something unusable, which the caller turns into
    /// a named 400 rather than silently dropping the protection they asked for.
    ///
    /// <para>
    /// <b>The tenant id is part of the reference, and that is not decoration.</b> The unique
    /// index on <c>ExternalReference</c> is global, while every read of the table is scoped
    /// by the tenant query filter — so two clubs sending the same key would collide in the
    /// index, and the second club's lookup for its "existing" row would find nothing,
    /// because the row belongs to the first. Scoping the reference means the keys of two clubs
    /// can never meet.
    /// </para>
    /// </summary>
    internal static string? IdempotencyReference(Guid tenantId, string? key)
    {
        if (key is null) return null;
        var trimmed = key.Trim();
        if (trimmed.Length is 0 or > 200) return "";
        return $"{AdjustmentReferencePrefix}{tenantId:N}:{trimmed}";
    }

    private static async Task<LedgerEntry?> ExistingAdjustmentAsync(
        MainframeDbContext db, string reference, CancellationToken ct)
        => await db.LedgerEntries.AsNoTracking()
            .FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);

    /// <summary>The answer to a desk movement: the sale's shape for a sale, the adjustment's otherwise.</summary>
    private static IResult MovementResult(
        LedgerEntry entry, DeskMovement m, int balanceBefore, int balanceAfter, Domain.User user)
    {
        // Block body: a property pattern in an expression body is the lizard trap (gotchas-gates).
        if (m.Package is null) return AdjustmentResult(entry, m.Kind, balanceBefore, balanceAfter, user);
        return SaleResult(entry, m.Kind, m.Package, (balanceBefore, balanceAfter), user);
    }

    // Block body, not an expression body: lizard's C# parser reads the `{` of an object
    // initialiser as the end of the function and dumps the whole rest of the file into a
    // *global* pseudo-function whose reported length trips `-L 200`. See memory/gotchas.md.
    private static IResult AdjustmentResult(
        LedgerEntry entry, AdminCreditReasons.Kind kind, int balanceBefore, int balanceAfter, Domain.User user)
    {
        return Results.Ok(new
        {
            entry_id = entry.Id,
            type = entry.Type.ToString(),
            reason_code = kind.Code,
            amount_minutes = entry.AmountMinutes,
            zar_received = entry.ZarPaid,
            // balance_before is here because the admin has to read back what they just did, and
            // the console's confirmation must not be composed client-side from a number it
            // fetched separately and may have fetched before.
            balance_before_minutes = balanceBefore,
            balance_after_minutes = balanceAfter,
            member = new { user_id = user.Id, email = user.Email },
        });
    }

    /// <summary>
    /// Settlement model I4: an adjustment may only name a booking in this tenant whose payer
    /// is the member being adjusted.
    ///
    /// <para>
    /// The field was copied onto the ledger row with no check of any kind — any GUID, any
    /// member. A desk crediting member U while pasting member V's booking id changed <b>V's</b>
    /// settlement: V's later late-scan reversal netted a compensation that was never paid to
    /// V, and nothing on V's ledger explained it. A nonexistent id was stored silently and
    /// then surfaced in the member's recent-bookings list as a booking they never had.
    /// </para>
    ///
    /// <para>
    /// 400 rather than 404: the desk's request was well-formed and addressed a real member,
    /// and the two error codes tell them which half they got wrong. Cross-tenant is already
    /// impossible — the query filter makes another club's booking simply not exist here —
    /// so it answers <c>booking_not_found</c>, which is what it is from this tenant's side.
    /// </para>
    /// </summary>
    private static async Task<IResult?> RefuseRelatedBooking(
        MainframeDbContext db, Guid userId, Guid? relatedBookingId, CancellationToken ct)
    {
        if (relatedBookingId is not { } bookingId) return null;

        var booking = await db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null) return Results.BadRequest(new { error = "booking_not_found" });

        var payer = booking.PaidByUserId ?? booking.UserId;
        return payer == userId ? null : Results.BadRequest(new { error = "booking_not_members" });
    }

    /// <summary>
    /// One frame on the wire. An empty <see cref="RealtimeMessage.Event"/> writes the legacy
    /// unnamed frame — which <c>balance.tsx</c> listens for as <c>message</c> and which is kept
    /// verbatim through the rollout — and anything else writes a named event a client can
    /// <c>addEventListener</c> on.
    /// </summary>
    private static async Task WriteFrameAsync(HttpContext ctx, RealtimeMessage frame, CancellationToken ct)
    {
        var line = string.IsNullOrEmpty(frame.Event)
            ? $"data: {frame.JsonPayload}\n\n"
            : $"event: {frame.Event}\ndata: {frame.JsonPayload}\n\n";
        await ctx.Response.WriteAsync(line, ct);
        await ctx.Response.Body.FlushAsync(ct);
    }

    /// <summary>
    /// Forces the keep-alive interval, so the loop can be exercised at millisecond speed.
    ///
    /// <para>
    /// Null in production, where the interval comes from <c>sse_keepalive_seconds</c> through
    /// <see cref="RealtimeSettings.KeepAlive"/> — it is a configurable number, so it is a tenant
    /// setting, like every other one.
    /// </para>
    /// </summary>
    internal static TimeSpan? KeepAliveOverride { get; set; }

    /// <summary>
    /// The keep-alive, written as a NAMED event rather than an SSE comment.
    ///
    /// <para>
    /// It was <c>": ping"</c>, a comment line. Comments keep proxies from timing the
    /// connection out, which is all it was ever asked to do — but <c>EventSource</c> does
    /// not surface them, so from the browser's side a stream delivering keep-alives and a
    /// stream that has silently gone deaf look identical, and the client had no way to
    /// notice the second. As a named event it does both jobs: the bytes still defeat proxy
    /// buffering, and the client can arm a watchdog on it. Clients that do not listen for
    /// <c>ping</c> ignore it, exactly as they ignored the comment.
    /// </para>
    /// </summary>
    private static async Task WriteKeepAliveAsync(HttpContext ctx, CancellationToken ct)
    {
        await ctx.Response.WriteAsync("event: ping\ndata: {}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
    }

}

/// <summary><paramref name="RelatedBookingId"/> is optional: set it when the adjustment compensates for a specific booking.</summary>
/// <summary>
/// The services the by-hand adjustment needs, bound as one parameter.
///
/// <para>
/// A minimal-API handler's parameter list is its injection point, so listing five services
/// individually put this method over the complexity gate's six-parameter bound on a count
/// that says nothing about how hard the method is to reason about.
/// <c>[AsParameters]</c> is the framework's own answer: each member is still resolved from
/// DI exactly as before, and the signature says what the handler takes rather than what the
/// container happens to hold.
/// </para>
/// </summary>
public sealed record AdjustServices(
    LedgerService Ledger,
    MainframeDbContext Db,
    Crusaders.Mainframe.Api.Multitenancy.ITenantContext Tenant,
    Crusaders.Mainframe.Api.Email.IEmailService Email,
    ILoggerFactory LoggerFactory,
    Crusaders.Mainframe.Api.Email.ClubIdentityResolver Club,
    AdminChangeRecorder Changes,
    // The adjustment's live balance frame is held until its transaction commits; see
    // WalletEndpoints.PostAndRecordAsync.
    RealtimeOutbox Outbox,
    // The club's money symbol, for the desk-sale mail's rand figure (P13 §6).
    TenantSettingsAccessor Settings);

/// <summary>
/// <paramref name="RelatedBookingId"/> is optional: set it when the adjustment compensates
/// for a specific booking.
///
/// <para>
/// <paramref name="IdempotencyKey"/> is the caller's own name for THIS movement, not for the
/// member and not for the amount. The console mints one when the Apply button is first
/// pressed and keeps it until that adjustment succeeds, so every retry of one intended
/// movement carries the same key and a genuinely second adjustment of the same amount for
/// the same reason carries a different one. Omitting it is still allowed — a script posting
/// by hand has nothing to retry — but then nothing stops a repeat.
/// </para>
/// </summary>
/// <param name="AmountMinutes">
/// Signed whole minutes, never 0, at most <c>999 999</c> either way. A <c>long</c> so an
/// over-long typo is refused by name rather than failing to bind (P13 §3.7).
/// </param>
/// <param name="ReasonCode">
/// WHAT KIND of adjustment this is — one of <see cref="AdminCreditReasons.AdjustmentCodes"/>,
/// each posting an <c>AdminAdjustment</c>. A package sold at the desk is the separate
/// <c>/sell</c> route; its top-up codes are refused here.
///
/// <para>
/// Nullable for one release only, read as <c>other</c> and logged as deprecated, because the
/// console gains the field in the same wave and every build already in the field would otherwise
/// start failing the moment this deploys.
/// </para>
/// </param>
public sealed record AdjustRequest(
    long AmountMinutes,
    string Reason,
    Guid? RelatedBookingId = null,
    string? IdempotencyKey = null,
    string? ReasonCode = null,
    [property: System.Text.Json.Serialization.JsonPropertyName("reason_code")] string? ReasonCodeSnake = null,
    decimal? ZarReceived = null,
    [property: System.Text.Json.Serialization.JsonPropertyName("zar_received")] decimal? ZarReceivedSnake = null)
{
    /// <summary>
    /// The code the caller sent under either spelling. <c>zarReceived</c> / <c>zar_received</c>
    /// stay bound and are ignored: an adjustment is not money the club took (P13 §3.7).
    ///
    /// <para>
    /// Both bind for the reason the settings PUT already documents at length: this API's GET
    /// answers snake_case and its bodies bind camelCase, and the cost of a client picking the
    /// wrong side is not an error — it is <c>null</c>, which here would silently downgrade a cash
    /// top-up to a goodwill adjustment and quietly drop it out of the club's revenue.
    /// </para>
    /// </summary>
    public string? ReasonCodeEither => ReasonCode ?? ReasonCodeSnake;
}
