using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// EF Core context. Every <see cref="ITenantScoped"/> entity is filtered to the current
/// tenant via global query filter; bypass requires <c>IgnoreQueryFilters()</c> and is reserved
/// for platform-admin operations + onboarding.
/// </summary>
public class MainframeDbContext : DbContext
{
    private readonly ITenantContext _tenant;

    public MainframeDbContext(DbContextOptions<MainframeDbContext> options, ITenantContext tenant)
        : base(options)
    {
        _tenant = tenant;
    }

    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<TenantSettings> TenantSettings => Set<TenantSettings>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Membership> Memberships => Set<Membership>();
    public DbSet<AuthToken> AuthTokens => Set<AuthToken>();
    public DbSet<Court> Courts => Set<Court>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<DeviceEventReceipt> DeviceEventReceipts => Set<DeviceEventReceipt>();
    public DbSet<Booking> Bookings => Set<Booking>();
    public DbSet<LedgerEntry> LedgerEntries => Set<LedgerEntry>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<WebhookEndpoint> WebhookEndpoints => Set<WebhookEndpoint>();
    public DbSet<WebhookDelivery> WebhookDeliveries => Set<WebhookDelivery>();
    public DbSet<EnrolledTemplate> EnrolledTemplates => Set<EnrolledTemplate>();
    public DbSet<BiometricMatchEvent> BiometricMatchEvents => Set<BiometricMatchEvent>();
    public DbSet<PendingTopup> PendingTopups => Set<PendingTopup>();
    public DbSet<WebAuthnCredential> WebAuthnCredentials => Set<WebAuthnCredential>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<Tenant>(e =>
        {
            e.ToTable("tenants");
            e.HasKey(t => t.Id);
            e.HasIndex(t => t.Slug).IsUnique();
            e.Property(t => t.Slug).HasMaxLength(64).IsRequired();
            e.Property(t => t.DisplayName).HasMaxLength(255).IsRequired();
            e.Property(t => t.Status).HasMaxLength(32).IsRequired();
        });

        modelBuilder.Entity<TenantSettings>(e =>
        {
            e.ToTable("tenant_settings");
            e.HasKey(s => s.TenantId);
            e.Property(s => s.SettingsJson).HasColumnType("jsonb");
            e.HasQueryFilter(s => s.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<User>(e =>
        {
            e.ToTable("users");
            e.HasKey(u => u.Id);
            e.HasIndex(u => new { u.TenantId, u.Email }).IsUnique();
            e.Property(u => u.Email).HasMaxLength(320).IsRequired();
            e.Property(u => u.Status).HasMaxLength(32).IsRequired();
            e.HasQueryFilter(u => u.TenantId == _tenant.TenantId || u.IsPlatformAdmin);
            e.HasOne(u => u.Membership)
             .WithOne(m => m.User!)
             .HasForeignKey<Membership>(m => m.UserId);
        });

        modelBuilder.Entity<Membership>(e =>
        {
            e.ToTable("memberships");
            e.HasKey(m => m.Id);
            e.HasIndex(m => new { m.TenantId, m.MembershipNumber }).IsUnique();
            e.Property(m => m.FullName).HasMaxLength(255).IsRequired();
            e.Property(m => m.MembershipNumber).HasMaxLength(64).IsRequired();
            e.Property(m => m.PhotoUrl).HasMaxLength(1024);
            e.Property(m => m.Status).HasConversion<int>();
            e.Property(m => m.MemberClass).HasConversion<int>().HasDefaultValue(MemberClass.Regular);
            e.HasQueryFilter(m => m.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<AuthToken>(e =>
        {
            e.ToTable("auth_tokens");
            e.HasKey(t => t.Id);
            e.HasIndex(t => t.TokenHash);
            e.Property(t => t.TokenHash).HasMaxLength(128).IsRequired();
            e.Property(t => t.Kind).HasConversion<int>();
            e.HasQueryFilter(t => t.TenantId == _tenant.TenantId);
        });

        ConfigureDevices(modelBuilder);

        modelBuilder.Entity<Court>(e =>
        {
            e.ToTable("courts");
            e.HasKey(c => c.Id);
            e.HasIndex(c => new { c.TenantId, c.CourtNumber }).IsUnique();
            e.Property(c => c.Name).HasMaxLength(128).IsRequired();
            e.Property(c => c.CourtType).HasConversion<int>();
            e.Property(c => c.SlicePriceCredits).HasColumnType("numeric(10,2)");
            e.HasQueryFilter(c => c.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<Booking>(e =>
        {
            e.ToTable("bookings");
            e.HasKey(b => b.Id);
            e.HasIndex(b => new { b.TenantId, b.CourtId, b.StartsAt });
            e.HasIndex(b => new { b.TenantId, b.UserId, b.StartsAt });
            e.Property(b => b.AmountChargedCredits).HasColumnType("numeric(10,2)");
            e.Property(b => b.Status).HasConversion<int>();
            e.Property(b => b.BlockLabel).HasMaxLength(128);
            e.Property(b => b.CancellationReason).HasMaxLength(512);
            e.HasQueryFilter(b => b.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<LedgerEntry>(e =>
        {
            e.ToTable("ledger_entries");
            e.HasKey(l => l.Id);
            e.HasIndex(l => new { l.TenantId, l.UserId, l.CreatedAt });
            e.HasIndex(l => l.ExternalReference).IsUnique().HasFilter("\"ExternalReference\" IS NOT NULL");
            e.Property(l => l.AmountCredits).HasColumnType("numeric(10,2)");
            e.Property(l => l.ZarPaid).HasColumnType("numeric(10,2)");
            e.Property(l => l.ConversionRate).HasColumnType("numeric(8,4)");
            e.Property(l => l.Type).HasConversion<int>();

            // A CHECK constraint on the enum's range. The column is a plain integer, so
            // without this a bad write — a bug, a bad migration, a hand-run UPDATE —
            // persists a value no code can interpret, and it lands in net_credits while
            // matching no bucket. The database is the last place that can refuse it.
            //
            // Widen this when the enum grows: LedgerEntryTypeCoverageTests pins the count,
            // so the two cannot drift apart silently.
            e.ToTable(t => t.HasCheckConstraint(
                "ck_ledger_entries_type_range",
                $"\"Type\" BETWEEN 0 AND {(int)Enum.GetValues<LedgerEntryType>().Max()}"));
            e.Property(l => l.Reason).HasMaxLength(512);
            e.Property(l => l.ExternalReference).HasMaxLength(255);
            e.HasQueryFilter(l => l.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<AuditLog>(e =>
        {
            e.ToTable("audit_log");
            e.HasKey(a => a.Id);
            e.HasIndex(a => new { a.TenantId, a.CreatedAt });
            e.Property(a => a.Action).HasMaxLength(128).IsRequired();
            e.Property(a => a.DetailsJson).HasColumnType("jsonb");
            e.HasQueryFilter(a => a.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<WebhookEndpoint>(e =>
        {
            e.ToTable("webhook_endpoints");
            e.HasKey(w => w.Id);
            e.HasIndex(w => new { w.TenantId, w.OwnerKind });
            e.Property(w => w.UrlTemplate).HasMaxLength(2048).IsRequired();
            e.Property(w => w.EventFilter).HasMaxLength(1024).IsRequired();
            e.Property(w => w.Secret).HasMaxLength(128).IsRequired();
            e.Property(w => w.Description).HasMaxLength(255);
            e.Property(w => w.OwnerKind).HasConversion<int>();
            e.HasQueryFilter(w => w.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<WebhookDelivery>(e =>
        {
            e.ToTable("webhook_deliveries");
            e.HasKey(w => w.Id);
            e.HasIndex(w => new { w.TenantId, w.EndpointId, w.CreatedAt });
            e.Property(w => w.EventId).HasMaxLength(64).IsRequired();
            e.Property(w => w.EventType).HasMaxLength(64).IsRequired();
            e.Property(w => w.Url).HasMaxLength(2048).IsRequired();
            e.Property(w => w.FinalState).HasMaxLength(16).IsRequired();
            e.HasQueryFilter(w => w.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<EnrolledTemplate>(e =>
        {
            e.ToTable("enrolled_templates");
            e.HasKey(t => t.Id);
            e.HasIndex(t => new { t.TenantId, t.UserId });
            e.Property(t => t.TemplateId).HasMaxLength(128).IsRequired();
            e.Property(t => t.FingerLabel).HasMaxLength(64);
            e.Property(t => t.ConsentReceiptHash).HasMaxLength(128);
            e.HasQueryFilter(t => t.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<BiometricMatchEvent>(e =>
        {
            e.ToTable("biometric_match_events");
            e.HasKey(b => b.Id);
            e.HasIndex(b => new { b.TenantId, b.CourtId, b.AttemptedAt });
            e.Property(b => b.Outcome).HasMaxLength(32).IsRequired();
            e.HasQueryFilter(b => b.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<WebAuthnCredential>(e =>
        {
            e.ToTable("webauthn_credentials");
            e.HasKey(w => w.Id);
            e.HasIndex(w => w.CredentialId).IsUnique();
            e.HasIndex(w => w.UserHandle);
            e.HasIndex(w => new { w.TenantId, w.UserId });
            e.Property(w => w.Label).HasMaxLength(255).IsRequired();
            e.Property(w => w.Transports).HasMaxLength(128);
            e.HasQueryFilter(w => w.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<PendingTopup>(e =>
        {
            e.ToTable("pending_topups");
            e.HasKey(p => p.Id);
            e.HasIndex(p => new { p.TenantId, p.UserId, p.CreatedAt });
            e.HasIndex(p => p.IdempotencyKey).IsUnique();
            e.HasIndex(p => p.ExternalReference).IsUnique().HasFilter("\"ExternalReference\" IS NOT NULL");
            e.Property(p => p.AmountZar).HasColumnType("numeric(10,2)");
            e.Property(p => p.IdempotencyKey).HasMaxLength(64).IsRequired();
            e.Property(p => p.GatewayCheckoutId).HasMaxLength(128);
            e.Property(p => p.ExternalReference).HasMaxLength(255);
            e.Property(p => p.Status).HasConversion<int>();
            e.Property(p => p.FailureReason).HasMaxLength(512);
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });
    }

    /// <summary>
    /// The devices table, lifted out of <c>OnModelCreating</c>.
    ///
    /// <para>
    /// Extracted because adding the MAC index pushed that method past the 200-line
    /// ceiling. Splitting one entity out is the honest fix — a whitelizard entry would
    /// have frozen a method that only ever grows, since every new table lands in it.
    /// </para>
    /// </summary>
    private void ConfigureDevices(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Device>(e =>
        {
            e.ToTable("devices");
            e.HasKey(d => d.Id);
            e.HasIndex(d => new { d.TenantId, d.DeviceCode }).IsUnique();
            e.HasIndex(d => new { d.TenantId, d.Kind });
            e.Property(d => d.DeviceCode).HasMaxLength(64).IsRequired();
            e.Property(d => d.Name).HasMaxLength(128).IsRequired();
            e.Property(d => d.GateKey).HasMaxLength(64);
            e.Property(d => d.LastIpAddress).HasMaxLength(64);
            e.Property(d => d.RunningVersion).HasMaxLength(32);
            e.Property(d => d.MegaVersion).HasMaxLength(32);
            e.Property(d => d.PinnedVersion).HasMaxLength(32);
            e.Property(d => d.Kind).HasConversion<int>();
            e.Property(d => d.Hardware).HasConversion<int>();
            e.Property(d => d.OtaChannel).HasConversion<int>();
            e.HasQueryFilter(d => d.TenantId == _tenant.TenantId);

            // Filtered unique: one row per physical board per tenant, while leaving
            // hand-registered devices (which have no MAC) unconstrained. Without it the
            // "already registered" check below is advisory — two concurrent claims for the
            // same board would both pass it and both insert.
            e.HasIndex(d => new { d.TenantId, d.MacAddress })
                .IsUnique()
                .HasFilter("\"MacAddress\" IS NOT NULL");
        });

        modelBuilder.Entity<DeviceEventReceipt>(e =>
        {
            e.ToTable("device_event_receipts");
            e.HasKey(r => r.Id);
            e.Property(r => r.Kind).HasMaxLength(32).IsRequired();
            e.HasQueryFilter(r => r.TenantId == _tenant.TenantId);

            // The whole reason this table exists. A box retrying an upload it never saw the
            // response to is normal traffic, and a check-then-insert loses to two retries
            // arriving together — both find nothing and both write. This makes the duplicate
            // impossible rather than unlikely.
            e.HasIndex(r => new { r.TenantId, r.DeviceId, r.Seq }).IsUnique();
        });
    }
}
