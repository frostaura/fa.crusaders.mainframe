using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A <see cref="CourtActivationService"/> that refuses, so the walk-up's refusal branch can
/// be driven at all.
///
/// <para>
/// In production every refusal on that branch is a race: the booking the commit has just
/// written and charged is decided by something else — cancelled, or otherwise not chargeable
/// — between the debit and the activation, and <c>ChargeOnActivationAsync</c> answers
/// <c>NotChargeable</c>. Nothing can schedule that from inside one call. The branch it
/// reaches is money code — the purchase is undone and the credits go back — so leaving it
/// undriven would mean shipping a refund path nobody has watched work.
/// </para>
///
/// <para>
/// This is the only reason <c>CourtActivationService</c> is unsealed and
/// <c>ActivateAsync(ActivationRequest, CancellationToken)</c> is virtual. Everything else on
/// the call under test is the real service, the real booking service and the real ledger.
/// Shared between the <c>TestHost</c> suite and the Postgres-backed one, which assert
/// different things about the same branch: what the member is told, and whether the row and
/// the refund commit together.
/// </para>
/// </summary>
internal sealed class RefusingActivation : CourtActivationService
{
    public RefusingActivation(IServiceScope scope) : base(
        scope.ServiceProvider.GetRequiredService<MainframeDbContext>(),
        scope.ServiceProvider.GetRequiredService<BookingService>(),
        scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>(),
        scope.ServiceProvider.GetRequiredService<ITenantContext>(),
        scope.ServiceProvider.GetRequiredService<IEventBus>(),
        NullLogger<CourtActivationService>.Instance)
    {
    }

    public override Task<ActivationResult> ActivateAsync(ActivationRequest request, CancellationToken ct)
        => Task.FromResult<ActivationResult>(new ActivationResult.NotChargeable());
}
