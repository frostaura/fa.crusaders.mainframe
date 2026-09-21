using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Assembles the control board's whole payload — GOAL item 10's read model.
///
/// <para>
/// SKELETON: the reader is filled in by the control-board work item. It exists here so the
/// container registration and the endpoint's route can land in the same wave as the projection
/// they depend on.
/// </para>
/// </summary>
public sealed class ControlBoardReader
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;

    public ControlBoardReader(MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings)
    {
        _db = db;
        _tenant = tenant;
        _settings = settings;
    }

    internal MainframeDbContext Db => _db;
    internal ITenantContext Tenant => _tenant;
    internal TenantSettingsAccessor Settings => _settings;
}
