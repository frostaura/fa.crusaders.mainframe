using System.Text;
using Crusaders.Mainframe.Api.Domain;
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
            if (req.AmountZar <= 0)
                return Results.BadRequest(new { error = "amount_must_be_positive" });
            if (!isAdmin && req.AmountZar % s.TopupBlockZar != 0m)
                return Results.BadRequest(new { error = "amount_must_be_multiple_of_block", block_zar = s.TopupBlockZar });
            if (!isAdmin && req.AmountZar > s.TopupMaxZarPerMember)
                return Results.BadRequest(new { error = "amount_exceeds_member_cap", max_zar = s.TopupMaxZarPerMember });

            var creds = await secrets.GetPaymentsAsync(ct);
            if (creds is null) return Results.Json(new { error = "payments_not_configured" }, statusCode: 503);

            var userId = ctx.User.Id() ?? Guid.Empty;
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.Unauthorized();

            var pending = new PendingTopup
            {
                TenantId = tenant.TenantId,
                UserId = userId,
                AmountZar = req.AmountZar,
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
                NotificationUrl: $"{publicBase}/api/v1/credit/topup/callback?tenant={tenant.TenantSlug}"), ct);

            if (!register.Ok)
            {
                pending.Status = TopUpStatus.Failed;
                pending.FailureReason = register.FailureReason;
                await db.SaveChangesAsync(ct);
                return Results.Json(new { error = "provider_register_failed", reason = register.FailureReason }, statusCode: 502);
            }

            pending.GatewayCheckoutId = register.CheckoutId;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { topup_id = pending.Id, checkout_id = register.CheckoutId, redirect_url = register.RedirectUrl });
        });

        g.MapGet("/topup/{topupId:guid}", async (Guid topupId, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var p = await db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == topupId && x.UserId == userId, ct);
            return p is null ? Results.NotFound() : Results.Ok(new { id = p.Id, status = p.Status.ToString(), amount_zar = p.AmountZar, failure_reason = p.FailureReason });
        });

        // Callback — PayFast ITN. Anonymous and signed; identifies the tenant via querystring.
        app.MapPost("/api/v1/credit/topup/callback", async (
            HttpRequest http,
            MainframeDbContext db,
            IPaymentProvider provider,
            TenantSecretsAccessor secrets,
            TenantSettingsAccessor settingsAccessor,
            LedgerService ledger,
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
                pending.FailureReason = $"amount_mismatch:reported={interp.AmountGross}:expected={pending.AmountZar}";
                await db.SaveChangesAsync(ct);

                return Results.BadRequest(new { error = "amount_mismatch" });
            }

            if (interp.Successful)
            {
                pending.Status = TopUpStatus.Completed;
                pending.ExternalReference = interp.PaymentId;
                pending.CompletedAt = DateTimeOffset.UtcNow;

                // Blueprint A.8 — convert ZAR to credits at the member's class-specific rate.
                var settings = await settingsAccessor.GetAsync(ct);
                var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == pending.UserId, ct);
                var memberClass = membership?.MemberClass ?? Crusaders.Mainframe.Api.Domain.MemberClass.Regular;
                var rate = settings.ConversionRateFor(memberClass);
                var credits = pending.AmountZar * rate;

                await ledger.PostAsync(new LedgerPosting(
                    UserId: pending.UserId,
                    Type: LedgerEntryType.TopUp,
                    AmountCredits: credits,
                    ZarPaid: pending.AmountZar,
                    ConversionRate: rate,
                    ActorUserId: pending.UserId,
                    Reason: $"PayFast top-up (R{pending.AmountZar:0.00} → {credits:0.00} credits @ {rate:0.0000})",
                    ExternalReference: interp.PaymentId), ct);

                await db.SaveChangesAsync(ct);

                await bus.EmitAsync(new DomainEvent(
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
            else
            {
                pending.Status = TopUpStatus.Failed;
                pending.FailureReason = interp.ResultDescription ?? interp.ResultCode ?? "failed";
                pending.CompletedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(ct);
                return Results.Ok(new { ok = false, reason = pending.FailureReason });
            }
        }).AllowAnonymous();

        return app;
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

}

public sealed record TopUpRequest(decimal AmountZar);
