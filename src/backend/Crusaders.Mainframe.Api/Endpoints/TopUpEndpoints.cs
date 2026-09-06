using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static partial class TopUpEndpoints
{
    public static IEndpointRouteBuilder MapTopUpEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/credit").RequireAuthorization();

        // What the top-up screen is allowed to offer, and at what rate.
        //
        // The screen used to carry `MIN_ZAR = 100`, `MAX_ZAR = 1000`, `BLOCK_ZAR = 100` and
        // two hardcoded conversion rates. An admin who moved any of them left the member
        // quoted 60% more credits than they would get, offered amounts the club had stopped
        // accepting and refused amounts it did accept — the screen disagreeing with the
        // server in both directions at once. Every configurable number is
        // tenant_settings.<key>; this is where the member's screen reads them.
        g.MapGet("/topup/options", async (
            HttpContext ctx,
            MainframeDbContext db,
            TenantSettingsAccessor settings,
            CancellationToken ct) =>
        {
            var s = await settings.GetAsync(ct);
            var memberClass = await MemberClassOfAsync(db, ctx.User.Id() ?? Guid.Empty, ct);
            return Results.Ok(new
            {
                block_zar = s.TopupBlockZar,
                min_zar = s.TopupBlockZar,
                max_zar = s.TopupMaxZarPerMember,
                presets_zar = Presets(s.TopupBlockZar, s.TopupMaxZarPerMember),
                conversion_rate = s.ConversionRateFor(memberClass),
                member_class = memberClass.ToString(),
            });
        });

        g.MapPost("/topup", async (
            TopUpRequest req,
            HttpContext ctx,
            MainframeDbContext db,
            IPaymentProvider provider,
            TenantSecretsAccessor secrets,
            TenantSettingsAccessor settings,
            IConfiguration config,
            Crusaders.Mainframe.Api.Multitenancy.ITenantContext tenant,
            CancellationToken ct) =>
        {
            var s = await settings.GetAsync(ct);

            // Blueprint A.3: top-ups in blocks of R100 to a max of R1000 for non-admin members.
            // Admins bypass the cap (their manual-adjustment path is the admin-unlimited route — this
            // endpoint is the member-facing PayFast flow).
            var isAdmin = ctx.User.IsInRole("admin");
            if (RefuseAmount(req.AmountZar, s, isAdmin) is { } refusal) return refusal;

            var creds = await secrets.GetPaymentsAsync(ct);
            if (creds is null) return Results.Json(new { error = "payments_not_configured" }, statusCode: 503);

            var userId = ctx.User.Id() ?? Guid.Empty;
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.Unauthorized();

            // The rate is captured HERE, with the offer, not re-resolved when the ITN lands.
            // See PendingTopup.ConversionRate: settling at the live rate meant an admin
            // editing credits_per_zar_* while a member sat on PayFast's card page changed
            // what that member got for money already paid.
            var memberClass = await MemberClassOfAsync(db, userId, ct);
            var rate = s.ConversionRateFor(memberClass);

            var pending = new PendingTopup
            {
                TenantId = tenant.TenantId,
                UserId = userId,
                AmountZar = req.AmountZar,
                ConversionRate = rate,
                MemberClass = memberClass,
                IdempotencyKey = $"tu_{Guid.NewGuid():N}",
                Status = TopUpStatus.Pending,
            };
            db.PendingTopups.Add(pending);
            await db.SaveChangesAsync(ct);

            var publicBase = config["App:PublicBaseUrl"] ?? "http://localhost:8089";
            var register = await provider.RegisterCheckoutAsync(new RegisterCheckoutRequest(
                creds, tenant.TenantId, userId, user.Email, req.AmountZar,
                pending.IdempotencyKey,
                ReturnUrl: $"{publicBase}/wallet/topup/{pending.Id}",
                NotificationUrl: $"{publicBase}/api/v1/credit/topup/callback?tenant={tenant.TenantSlug}")
            {
                // PayFast requires a cancel_url and it was never set, so the field was empty,
                // dropped from the signed list, and a member who backed out at the gateway had
                // nowhere to land. Same page as the return URL — it polls the status and will
                // show them the cancellation the ITN reports.
                CancelUrl = $"{publicBase}/wallet/topup/{pending.Id}?cancelled=1",
            }, ct);

            if (!register.Ok)
            {
                pending.Status = TopUpStatus.Failed;
                pending.FailureReason = FailureCodes.ProviderRegisterFailed;
                await db.SaveChangesAsync(ct);
                return Results.Json(new { error = "provider_register_failed", reason = register.FailureReason }, statusCode: 502);
            }

            pending.GatewayCheckoutId = register.CheckoutId;
            await db.SaveChangesAsync(ct);

            // form_fields is the payment. PayFast has no server-side checkout registration —
            // the browser POSTs a SIGNED FORM to the process URL — and this endpoint used to
            // return the bare process URL and nothing else, which the frontend then followed
            // as a GET with no merchant id, no amount and no signature. No payment could
            // start. The provider had been building and signing the field list all along and
            // nothing outside its own unit test ever read it.
            return Results.Ok(new
            {
                topup_id = pending.Id,
                checkout_id = register.CheckoutId,
                redirect_url = register.RedirectUrl,
                form_fields = register.FormFields.Select(f => new { name = f.Key, value = f.Value }).ToList(),
                quoted_credits = Convert(pending.AmountZar, rate),
                conversion_rate = rate,
            });
        });

        g.MapGet("/topup/{topupId:guid}", async (Guid topupId, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var p = await db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == topupId && x.UserId == userId, ct);
            return p is null
                ? Results.NotFound()
                : Results.Ok(new
                {
                    id = p.Id,
                    status = p.Status.ToString(),
                    amount_zar = p.AmountZar,
                    conversion_rate = p.ConversionRate,
                    // A stable code the client maps to a sentence, never an internal string.
                    failure_code = p.FailureReason,
                });
        });

        // Callback — PayFast ITN. Anonymous and signed; identifies the tenant via querystring.
        app.MapPost("/api/v1/credit/topup/callback", async (
            HttpRequest http,
            MainframeDbContext db,
            IPaymentProvider provider,
            TenantSecretsAccessor secrets,
            TenantSettingsAccessor settingsAccessor,
            LedgerService ledger,
            IEmailService emailService,
            IEventBus bus,
            Crusaders.Mainframe.Api.Multitenancy.ITenantContext tenant,
            ILoggerFactory loggerFactory,
            CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("TopUpCallback");
            var slug = http.Query["tenant"].ToString();
            if (string.IsNullOrEmpty(slug)) return Results.BadRequest(new { error = "tenant_missing" });

            var tenantRow = await db.Tenants.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Slug == slug, ct);
            if (tenantRow is null) return Results.NotFound();
            tenant.Set(tenantRow.Id, tenantRow.Slug);

            var creds = await secrets.GetPaymentsAsync(ct);
            if (creds is null) return Results.Json(new { error = "payments_not_configured" }, statusCode: 503);

            string raw;
            using (var sr = new StreamReader(http.Body, Encoding.UTF8, leaveOpen: true)) raw = await sr.ReadToEndAsync(ct);

            // PayFast posts application/x-www-form-urlencoded and signs the fields IN THE
            // ORDER SENT, so the raw body is parsed positionally. Using http.Form here would
            // hand back a sorted dictionary and every notification would fail to verify,
            // with nothing in the log saying why.
            var fields = ParseFormPreservingOrder(raw);

            var interp = await provider.InterpretCallbackAsync(
                new CallbackPayload(creds, raw, SignatureHeader: "", fields)
                {
                    SourceIp = http.HttpContext.Connection.RemoteIpAddress?.ToString(),
                }, ct);

            if (!interp.SignatureValid)
            {
                logger.LogWarning("topup callback signature invalid for tenant {Slug}", slug);
                return Results.Unauthorized();
            }

            if (interp.MerchantTransactionId is null) return Results.BadRequest(new { error = "merchant_txn_missing" });
            var pending = await db.PendingTopups.FirstOrDefaultAsync(p => p.IdempotencyKey == interp.MerchantTransactionId, ct);
            if (pending is null) return Results.NotFound();

            // PayFast retries an ITN until it is acknowledged and the short-circuit below only
            // covers Completed, so a row that has already failed is re-judged on every retry.
            // The member must be told once, not once per retry.
            var wasPending = pending.Status == TopUpStatus.Pending;

            // Idempotent: PayFast retries an ITN until it is acknowledged, so a repeat is
            // the normal case rather than an attack. Answering 200 stops the retries.
            if (pending.Status == TopUpStatus.Completed)
                return Results.Ok(new { ok = true, idempotent = true });

            // The amount is signed, so this cannot be forged — but it CAN legitimately
            // differ from what was asked for, and a correctly-signed notification for R1
            // must not credit the member for the R1000 they requested. The signature proves
            // the message is authentic, not that it is the message expected.
            if (interp.AmountGross is not null && interp.AmountGross != pending.AmountZar)
            {
                logger.LogWarning(
                    "topup {Key}: PayFast reports {Reported} but the pending top-up is {Expected} — refusing",
                    pending.IdempotencyKey, interp.AmountGross, pending.AmountZar);

                pending.Status = TopUpStatus.Failed;
                pending.FailureReason = FailureCodes.AmountMismatch;
                await db.SaveChangesAsync(ct);

                if (wasPending) await NotifyNotCompletedAsync(db, emailService, logger, pending, ct);
                return Results.BadRequest(new { error = "amount_mismatch" });
            }

            if (interp.Successful)
            {
                return await CompleteAsync(
                    new TopUpCompletion(db, ledger, settingsAccessor, emailService, bus, logger),
                    pending, tenantRow, interp, ct);
            }

            // PENDING is not a failure. PayFast sends one while an EFT clears, and marking
            // the row Failed on it meant a payment still in flight could never be completed
            // by the COMPLETE that follows — the idempotency check only short-circuits on
            // Completed, but the member had already been told it failed.
            if (string.Equals(interp.ResultCode, "PENDING", StringComparison.OrdinalIgnoreCase))
                return Results.Ok(new { ok = false, reason = "pending" });

            // CANCELLED is the member's own decision and is a distinct terminal state.
            // It was stored as Failed, so someone who deliberately backed out was told
            // their payment failed.
            var cancelled = string.Equals(interp.ResultCode, "CANCELLED", StringComparison.OrdinalIgnoreCase);
            pending.Status = cancelled ? TopUpStatus.Cancelled : TopUpStatus.Failed;
            pending.FailureReason = cancelled ? FailureCodes.Cancelled
                : string.Equals(interp.ResultCode, "FAILED", StringComparison.OrdinalIgnoreCase) ? FailureCodes.Declined
                : FailureCodes.GatewayError;
            pending.CompletedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);

            if (wasPending) await NotifyNotCompletedAsync(db, emailService, logger, pending, ct);
            return Results.Ok(new { ok = false, reason = pending.FailureReason });
        }).AllowAnonymous();

        return app;
    }

    /// <summary>
    /// Tells the member their top-up ended without credits — <c>feature-spec.md</c> §11.
    ///
    /// <para>
    /// This was the one terminal outcome of handing over card details that sent nothing.
    /// Confirmation was emailed, failure was not, so a member who closed the tab after
    /// PayFast could only learn what happened by finding the status page again — and the
    /// status page's own copy on the branch where it cannot reach the club promises this
    /// mail in as many words, which is exactly the branch where the mail is the only
    /// channel left. Cancellations get it too, because "either way" is what the screen says
    /// and a member who backed out still deserves to know nothing was taken.
    /// </para>
    ///
    /// <para>
    /// Dispatched in the background for the same reason the confirmation is: PayFast retries
    /// an ITN until it is acknowledged, so a slow SMTP handshake on this path becomes a
    /// duplicate notification. Callers gate it on the row having still been <c>Pending</c>,
    /// so a retried ITN on an already-failed row does not mail the member again.
    /// </para>
    /// </summary>
    private static async Task NotifyNotCompletedAsync(
        MainframeDbContext db, IEmailService email, ILogger logger, PendingTopup pending, CancellationToken ct)
    {
        var recipient = await db.Users.AsNoTracking()
            .Where(u => u.Id == pending.UserId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(recipient)) return;

        EmailDispatch.InBackground(
            email, logger,
            EmailTemplates.TopUpNotCompleted(
                recipient, pending.AmountZar, pending.FailureReason,
                pending.ExternalReference ?? pending.IdempotencyKey),
            $"top-up failure notice for {pending.Id}");
    }

    /// <summary>The services <see cref="CompleteAsync"/> needs, bundled so the method stays inside the argument gate.</summary>
    internal sealed record TopUpCompletion(
        MainframeDbContext Db,
        LedgerService Ledger,
        TenantSettingsAccessor Settings,
        IEmailService Email,
        IEventBus Bus,
        ILogger Logger);

    /// <summary>
    /// Converts a completed payment to credits and posts it.
    ///
    /// <para>
    /// The rate is <see cref="PendingTopup.ConversionRate"/> — what the member was quoted —
    /// falling back to the live tenant rate only for rows written before that column
    /// existed. Re-resolving it here is the defect this method exists to hold shut.
    /// </para>
    /// </summary>
    private static async Task<IResult> CompleteAsync(
        TopUpCompletion c, PendingTopup pending, Tenant tenantRow, CallbackInterpretation interp, CancellationToken ct)
    {
        pending.Status = TopUpStatus.Completed;
        pending.ExternalReference = interp.PaymentId;
        pending.CompletedAt = DateTimeOffset.UtcNow;

        var settings = await c.Settings.GetAsync(ct);
        var memberClass = pending.MemberClass
            ?? await MemberClassOfAsync(c.Db, pending.UserId, ct);

        decimal rate;
        if (pending.ConversionRate is { } quoted)
        {
            rate = quoted;
        }
        else
        {
            rate = settings.ConversionRateFor(memberClass);
            c.Logger.LogInformation(
                "topup {Key} carries no quoted rate (pre-dates the column) — settling at the live rate {Rate}",
                pending.IdempotencyKey, rate);
        }

        // Rounded to the column, not by the column.
        //
        // ledger_entries.AmountCredits is numeric(10,2), so an unrounded product is
        // rounded on the way in regardless — but the HTTP response, the
        // credit.topped_up event and the ledger Reason string all quote the value
        // this variable holds, so they quoted a figure the database had not stored.
        // credits_per_zar_* accepts four decimals and admins bypass the block rule,
        // which is all it takes for the two to diverge. AwayFromZero matches
        // CreateWalkUpAsync and both penalty computations: the club does not round
        // in its own favour by accident.
        var credits = Convert(pending.AmountZar, rate);

        await c.Ledger.PostAsync(new LedgerPosting(
            UserId: pending.UserId,
            Type: LedgerEntryType.TopUp,
            AmountCredits: credits,
            ZarPaid: pending.AmountZar,
            ConversionRate: rate,
            ActorUserId: pending.UserId,
            // Invariant separators, so the comment reads in the same convention as the
            // amount column beside it rather than the server's ambient culture.
            Reason: $"PayFast top-up ({EmailTemplates.Zar(pending.AmountZar)} → {EmailTemplates.Cr(credits)} @ {EmailTemplates.Num(rate)})",
            ExternalReference: interp.PaymentId), ct);

        await c.Db.SaveChangesAsync(ct);

        var balanceAfter = await c.Ledger.GetBalanceAsync(pending.UserId, ct);

        // feature-spec.md §11 has required a top-up confirmation since it was written and
        // nothing sent one, so the single event where a member hands over real money was
        // the one event that produced no email. Dispatched in the background: PayFast
        // retries an ITN until it is acknowledged, so a slow SMTP handshake here becomes a
        // duplicate notification.
        var recipient = await c.Db.Users.AsNoTracking()
            .Where(u => u.Id == pending.UserId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (!string.IsNullOrEmpty(recipient))
        {
            EmailDispatch.InBackground(
                c.Email, c.Logger,
                EmailTemplates.TopUpConfirmation(
                    recipient, pending.AmountZar, credits, rate, balanceAfter,
                    interp.PaymentId ?? pending.IdempotencyKey),
                $"top-up confirmation for {pending.Id}");
        }

        await c.Bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "credit.topped_up",
            TenantId: tenantRow.Id, TenantSlug: tenantRow.Slug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: pending.UserId, ActorIsAdmin: false, SubjectUserId: pending.UserId,
            Data: new()
            {
                ["topup_id"] = pending.Id,
                ["zar_paid"] = pending.AmountZar,
                ["credits"] = credits,
                ["conversion_rate"] = rate,
                ["member_class"] = memberClass.ToString(),
                ["external_reference"] = interp.PaymentId,
            }), ct);

        return Results.Ok(new { ok = true, credits, conversion_rate = rate });
    }

    /// <summary>ZAR → credits at a given rate, rounded the way the column stores it.</summary>
    internal static decimal Convert(decimal amountZar, decimal rate)
        => Math.Round(amountZar * rate, 2, MidpointRounding.AwayFromZero);

    private static async Task<MemberClass> MemberClassOfAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
        => (await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct))?.MemberClass
           ?? MemberClass.Regular;

    /// <summary>
    /// The refusal for an amount the club will not take, or null when it will.
    ///
    /// <para>
    /// Lifted out of the handler so the same three rules can be quoted to the screen by
    /// <c>/topup/options</c> and enforced here, rather than being written twice and
    /// drifting — which is exactly what happened.
    /// </para>
    /// </summary>
    internal static IResult? RefuseAmount(decimal amountZar, TenantSettingsView s, bool isAdmin)
    {
        if (amountZar <= 0)
            return Results.BadRequest(new { error = "amount_must_be_positive" });
        if (!isAdmin && s.TopupBlockZar > 0 && amountZar % s.TopupBlockZar != 0m)
            return Results.BadRequest(new { error = "amount_must_be_multiple_of_block", block_zar = s.TopupBlockZar });
        if (!isAdmin && amountZar > s.TopupMaxZarPerMember)
            return Results.BadRequest(new { error = "amount_exceeds_member_cap", max_zar = s.TopupMaxZarPerMember });
        return null;
    }

    /// <summary>
    /// The quick-pick amounts, derived from the tenant's own block and cap rather than
    /// hardcoded on the screen. 1×, 2×, 5× the block plus the cap itself, keeping only the
    /// ones the rules above would actually accept.
    /// </summary>
    internal static List<decimal> Presets(decimal blockZar, decimal maxZar)
    {
        if (blockZar <= 0) return [];
        var candidates = new List<decimal> { blockZar, blockZar * 2, blockZar * 5, maxZar };
        return candidates
            .Where(v => v > 0 && v <= maxZar && v % blockZar == 0m)
            .Distinct()
            .OrderBy(v => v)
            .ToList();
    }

    /// <summary>
    /// Parses <c>application/x-www-form-urlencoded</c> <b>preserving the order fields were
    /// sent in</b>, which is what PayFast signs over.
    ///
    /// <para>
    /// ASP.NET's <c>http.Form</c> is not usable here: it returns a sorted, de-duplicated
    /// dictionary. Ordering is invisible in every unit test that builds its own dictionary
    /// and fatal against the real gateway, which is the worst combination.
    /// </para>
    /// </summary>
    internal static List<KeyValuePair<string, string>> ParseFormPreservingOrder(string body)
    {
        var fields = new List<KeyValuePair<string, string>>();
        if (string.IsNullOrEmpty(body)) return fields;

        foreach (var pair in body.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            var key = eq < 0 ? pair : pair[..eq];
            var value = eq < 0 ? string.Empty : pair[(eq + 1)..];

            // '+' means space in a form body, and Uri.UnescapeDataString does not know that.
            fields.Add(new KeyValuePair<string, string>(
                Uri.UnescapeDataString(key.Replace('+', ' ')),
                Uri.UnescapeDataString(value.Replace('+', ' '))));
        }

        return fields;
    }

    // FailureCodes sits AFTER MapTopUpEndpoints, and where it sits changes what lizard calls
    // the map method: the C# parser scopes whatever FOLLOWS a nested class into that class, so
    // this order is reported as `TopUpEndpoints::MapTopUpEndpoints` and the other order as
    // `FailureCodes::MapTopUpEndpoints`. Both are the same function; only the label moves.
    //
    // THE PLACEMENT IS NO LONGER WHAT HOLDS THE GATE — whitelizard.txt does, by listing BOTH
    // names (see the note at the top of that file). It used to be load-bearing, and that is
    // exactly why it stopped being so: one round moved this class to make the single entry
    // match while another renamed the entry, each was green alone, and the merge was red on a
    // file nobody had edited. So move this class if you have a reason to; do NOT delete either
    // whitelizard line as redundant, because whichever one looks redundant is the one that
    // catches the next move. Verified 2026-09-06 by making that move in a scratch copy: the
    // reported name flipped to `FailureCodes::MapTopUpEndpoints` and `make complexity` stayed
    // green (exit 0) with both entries present.
    //
    // The underlying parser quirk is the one memory/gotchas.md records for expression-bodied
    // members whose bodies carry braces: what lizard reports is placement, not content.
    /// <summary>
    /// Stable, snake_case reasons a top-up did not complete.
    ///
    /// <para>
    /// These are stored on <c>pending_topups.FailureReason</c> and served to the client,
    /// which maps them to sentences. The column used to hold whatever string was nearest —
    /// <c>amount_mismatch:reported=100,00:expected=500,00</c> was rendered verbatim to a
    /// member as the explanation for a failed R500 payment, en-ZA comma decimals and all.
    /// The numbers behind a mismatch are in the log, where the person who needs them is.
    /// </para>
    /// </summary>
    public static class FailureCodes
    {
        /// <summary>PayFast reported an amount other than the one the top-up was registered for.</summary>
        public const string AmountMismatch = "amount_mismatch";

        /// <summary>The member backed out at the gateway. Not a failure, and must not be shown as one.</summary>
        public const string Cancelled = "cancelled";

        /// <summary>The gateway declined the payment — card refused, insufficient funds, 3DS abandoned.</summary>
        public const string Declined = "declined";

        /// <summary>The gateway answered with something this application does not recognise.</summary>
        public const string GatewayError = "gateway_error";

        /// <summary>The checkout could not be registered at all — usually missing merchant credentials.</summary>
        public const string ProviderRegisterFailed = "provider_register_failed";
    }

}

/// <summary>
/// The amount a member wants to pay, in <b>rand</b>.
///
/// <para>
/// The client posted <c>amountCredits</c> against this record for as long as the screen
/// existed, so <c>AmountZar</c> bound to 0, the first guard fired, and no member could
/// ever top up — the screen told them the amount was wrong. The field is rand because
/// PayFast is paid in rand; the credits are what comes back.
/// </para>
/// </summary>
public sealed record TopUpRequest(decimal AmountZar);
