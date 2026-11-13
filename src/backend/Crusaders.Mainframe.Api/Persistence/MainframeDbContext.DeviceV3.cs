using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The device contract v3 tables (<c>docs/specs/device-api.md</c> §6–§8): the club's retained
/// device keys, its device network and its signed firmware releases. A partial of its own for
/// the 200-line reason, in the same class so each query filter is parameterised per instance.
/// </summary>
public partial class MainframeDbContext
{
    /// <summary>Superseded device keys still accepted until retired (§6).</summary>
    public DbSet<DevicePreviousKey> DevicePreviousKeys => Set<DevicePreviousKey>();

    /// <summary>The club's versioned device network (§8).</summary>
    public DbSet<DeviceNetwork> DeviceNetworks => Set<DeviceNetwork>();

    /// <summary>Signed OTA images and their rollout (§7).</summary>
    public DbSet<FirmwareRelease> FirmwareReleases => Set<FirmwareRelease>();

    private void ConfigureDeviceV3(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<DevicePreviousKey>(e =>
        {
            e.ToTable("device_previous_keys");
            e.HasKey(k => k.Id);
            e.Property(k => k.Key).HasMaxLength(Security.DeviceAuth.DeviceApiKey.MaxLength).IsRequired();
            e.HasIndex(k => new { k.TenantId, k.KeyId }).IsUnique();
            e.HasQueryFilter(k => k.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<DeviceNetwork>(e =>
        {
            e.ToTable("device_networks");
            e.HasKey(n => n.TenantId);
            e.Property(n => n.BaseUrl).HasMaxLength(Services.DeviceProvision.BaseUrlMax);
            e.Property(n => n.Wifi0Ssid).HasMaxLength(64);
            e.Property(n => n.Wifi1Ssid).HasMaxLength(64);
            e.Property(n => n.Wifi0PskCipher).HasMaxLength(512);
            e.Property(n => n.Wifi1PskCipher).HasMaxLength(512);
            e.HasQueryFilter(n => n.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<FirmwareRelease>(e =>
        {
            e.ToTable("firmware_releases");
            e.HasKey(r => r.Id);
            e.Property(r => r.Target).HasMaxLength(16).IsRequired();
            e.Property(r => r.Version).HasMaxLength(16).IsRequired();
            e.Property(r => r.Sha256).HasMaxLength(64).IsRequired();
            e.Property(r => r.Signature).HasMaxLength(342).IsRequired();
            e.Property(r => r.Rollout).HasMaxLength(8).IsRequired();
            e.Property(r => r.Image).IsRequired();
            e.HasIndex(r => new { r.TenantId, r.Target, r.Version }).IsUnique();
            e.ToTable(t => t.HasCheckConstraint(
                "ck_firmware_releases_rollout", "\"Rollout\" IN ('off', 'one', 'all')"));
            e.HasQueryFilter(r => r.TenantId == _tenant.TenantId);
        });
    }
}
