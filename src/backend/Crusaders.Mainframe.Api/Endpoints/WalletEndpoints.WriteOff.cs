using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

public static partial class WalletEndpoints
{
    /// <summary>The ledger's own words for a balance written off when the club deleted the member.</summary>
    internal const string WriteOffLedgerReason = "Balance written off: the club deleted this account";

    /// <summary>
    /// Writes a deleted member's remaining balance off to nothing, through the desk's own adjustment
    /// path (<see cref="PostAndRecordAsync"/>): one <c>AdminAdjustment</c> of minus the balance under
    /// the payer's lock, its <c>credit.adjusted</c> audit row with the two balances, and its
    /// <c>minutes.adjusted</c> change-record row with the admin's reason — so the ledger, the club's
    /// reports and its record agree that the minutes left the books, and why. No mail: the member's
    /// deletion mail says it.
    ///
    /// <para>
    /// <b>Idempotent per member.</b> The movement carries a reference derived from the member alone,
    /// so a retried delete (a lost reply, a second press) finds the write-off it already posted and
    /// posts nothing; the filtered unique index on the reference holds the line in a race.
    /// </para>
    /// </summary>
    /// <returns>The minutes written off — positive for a balance taken away, negative for a debt cleared.</returns>
    internal static async Task<int> WriteOffDeletedMemberAsync(Guid userId, string reason, HttpContext ctx, CancellationToken ct)
    {
        var services = DeskServices(ctx.RequestServices);
        var reference = IdempotencyReference(services.Tenant.TenantId, $"member-deleted:{userId:N}")!;
        if (await ExistingAdjustmentAsync(services.Db, reference, ct) is { } already) return -already.AmountMinutes;

        var balance = await services.Ledger.GetBalanceAsync(userId, ct);
        if (balance == 0) return 0;

        var kind = new AdminCreditReasons.Kind(AdminCreditReasons.Other, LedgerEntryType.AdminAdjustment);
        var movement = new DeskMovement(userId, kind, -balance, null, WriteOffLedgerReason, reason) { Reference = reference };
        var (posted, raced) = await PostAndRecordAsync(movement, ctx, services, ct);
        if (posted is not null) return balance;

        services.Db.ChangeTracker.Clear();
        var twin = await ExistingAdjustmentAsync(services.Db, reference, ct);
        if (twin is null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(raced!);
        return -twin!.AmountMinutes;
    }

    /// <summary>The desk's collaborators, read from a request's services for a caller that is not the adjust route itself.</summary>
    private static AdjustServices DeskServices(IServiceProvider sp)
    {
        return new AdjustServices(
            sp.GetRequiredService<LedgerService>(),
            sp.GetRequiredService<Persistence.MainframeDbContext>(),
            sp.GetRequiredService<Multitenancy.ITenantContext>(),
            sp.GetRequiredService<Email.IEmailService>(),
            sp.GetRequiredService<ILoggerFactory>(),
            sp.GetRequiredService<Email.ClubIdentityResolver>(),
            sp.GetRequiredService<AdminChangeRecorder>(),
            sp.GetRequiredService<Services.Realtime.RealtimeOutbox>(),
            sp.GetRequiredService<TenantSettingsAccessor>());
    }
}
