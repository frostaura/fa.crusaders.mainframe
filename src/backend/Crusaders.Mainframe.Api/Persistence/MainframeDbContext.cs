using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Services;
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
    public DbSet<DeviceOutage> DeviceOutages => Set<DeviceOutage>();
    public DbSet<Booking> Bookings => Set<Booking>();
    public DbSet<LedgerEntry> LedgerEntries => Set<LedgerEntry>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();

    /// <summary>
    /// The club's undeletable record of what its administrators did.
    ///
    /// <para>
    /// <b>There is no <c>Remove</c> anywhere in this tree for this set, and there must never
    /// be.</b> <c>AdminChangeLogPostureTests</c> greps for one; the table's own triggers raise
    /// <c>42501</c> on <c>DELETE</c>, <c>UPDATE</c> and <c>TRUNCATE</c>; and
    /// <c>RetentionWorker</c> never names it. See <see cref="AdminChangeLog"/> for why it is not
    /// <see cref="AuditLogs"/>.
    /// </para>
    /// </summary>
    public DbSet<AdminChangeLog> AdminChangeLogs => Set<AdminChangeLog>();
    public DbSet<WebhookEndpoint> WebhookEndpoints => Set<WebhookEndpoint>();
    public DbSet<WebhookDelivery> WebhookDeliveries => Set<WebhookDelivery>();
    public DbSet<EnrolledTemplate> EnrolledTemplates => Set<EnrolledTemplate>();
    public DbSet<BiometricMatchEvent> BiometricMatchEvents => Set<BiometricMatchEvent>();
    public DbSet<PendingTopup> PendingTopups => Set<PendingTopup>();
    public DbSet<WebAuthnCredential> WebAuthnCredentials => Set<WebAuthnCredential>();
    public DbSet<AccessCode> AccessCodes => Set<AccessCode>();

    /// <summary>
    /// Builds the model, including the global query filter on every tenant-scoped entity.
    /// </summary>
    /// <remarks>
    /// <para><b>Why the <c>users</c> filter is a plain equality and must stay one.</b></para>
    ///
    /// <para>
    /// It used to read <c>u.TenantId == _tenant.TenantId || u.IsPlatformAdmin</c> — the only
    /// disjunction in the model — which put every platform-admin row in the deployment inside
    /// every tenant's <c>db.Users</c>. That was reachable, not theoretical: the existence
    /// check in <c>POST /api/v1/admin/credit/{userId}/adjust</c> passed on a foreign row, so a
    /// tenant admin could post ledger entries in their own tenant against a user who was not
    /// in it, and those entries then counted in that tenant's revenue report.
    /// </para>
    ///
    /// <para>
    /// Nothing needed the escape: no platform admin is seeded, and the <c>/api/v1/platform/</c>
    /// endpoints it existed for are not mapped. When they are, they belong on a
    /// filter-bypassing repository of their own rather than on a hole punched through every
    /// tenant's user list.
    /// </para>
    /// </remarks>
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
            // Plain equality. See the remarks on OnModelCreating for why it must stay one.
            e.HasQueryFilter(u => u.TenantId == _tenant.TenantId);
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
        ConfigureAccessCodes(modelBuilder);

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
            e.Property(b => b.Version).IsConcurrencyToken();
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

        ConfigureAuditLog(modelBuilder);
        ConfigureAdminChangeLog(modelBuilder);

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
            // Same precision as ledger_entries.ConversionRate — the two hold the same number
            // and a narrower column here would silently round the rate the ledger then quotes.
            e.Property(p => p.ConversionRate).HasColumnType("numeric(8,4)");
            e.Property(p => p.MemberClass).HasConversion<int?>();
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
            // The same constant the admin PATCH validates against, so the refusal an admin
            // reads and the width the column enforces cannot drift apart. Identical value,
            // so no migration: this names 64, it does not change it.
            e.Property(d => d.GateKey).HasMaxLength(Device.GateKeyMaxLength);
            // Same rule, same reason, for the door card's prose field.
            e.Property(d => d.LocationNote).HasMaxLength(Device.LocationNoteMaxLength);
            e.Property(d => d.PowerLossBehaviour).HasConversion<int>();
            e.Property(d => d.MacAddress).HasMaxLength(12).IsRequired();
            e.Property(d => d.LastIpAddress).HasMaxLength(64);
            e.Property(d => d.RunningVersion).HasMaxLength(32);
            e.Property(d => d.MegaVersion).HasMaxLength(32);
            e.Property(d => d.Kind).HasConversion<int>();
            e.Property(d => d.Hardware).HasConversion<int>();
            e.HasQueryFilter(d => d.TenantId == _tenant.TenantId);

            // One row per physical board per tenant. Without it the "have I seen this MAC
            // before?" check in auto-registration is advisory — two heartbeats from a box
            // that has just been switched on arrive together, both find nothing, and the
            // club ends up with two rows for one board.
            e.HasIndex(d => new { d.TenantId, d.MacAddress }).IsUnique();
        });

        modelBuilder.Entity<DeviceOutage>(e =>
        {
            e.ToTable("device_outages");
            e.HasKey(o => o.Id);
            e.HasQueryFilter(o => o.TenantId == _tenant.TenantId);

            // At most one OPEN outage per box. The health sweep's "have I already alerted for
            // this outage?" check is a read followed by a write, and two ticks overlapping —
            // a slow one and its successor — would otherwise both find nothing and both open a
            // row, alerting the club twice and leaving two windows for the no-show waiver to
            // read. The filter is what makes it a uniqueness rule about the PRESENT: closed
            // outages accumulate freely, which is the history the waiver needs.
            e.HasIndex(o => new { o.TenantId, o.DeviceId })
                .IsUnique()
                .HasFilter("\"EndedAt\" IS NULL");

            // The no-show waiver's lookup: this tenant's outages overlapping a booking's grace
            // window. Without it every swept booking table-scans the outage history.
            e.HasIndex(o => new { o.TenantId, o.StartedAt });
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
            //
            // BOOT_ID IS PART OF IT, and see DeviceEventReceipt.BootId for why: without it a
            // board whose sequence checkpoint was erased renumbered from 1 and had its whole
            // next evening discarded as duplicates, against an index that is permanent.
            // Absent on the wire means 0, which reproduces the old key exactly, so a court
            // box and every pre-change gate image are unaffected.
            e.HasIndex(r => new { r.TenantId, r.DeviceId, r.BootId, r.Seq }).IsUnique();

            // The lookup a `release` event makes: the last activation this box lit on this
            // relay. Without it, pairing a release to its session is a table scan on every
            // court switch-off. See docs/specs/settlement-model.md §4.
            e.HasIndex(r => new { r.TenantId, r.DeviceId, r.Court, r.OccurredAt });
        });
    }

    /// <summary>
    /// The codes a member's phone shows a court box. Lifted out of <c>OnModelCreating</c>
    /// for the same length reason as the devices.
    /// </summary>
    private void ConfigureAccessCodes(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AccessCode>(e =>
        {
            e.ToTable("access_codes");
            e.HasKey(c => c.Id);
            e.Property(c => c.Code).HasMaxLength(20).IsRequired();
            e.Property(c => c.Purpose).HasConversion<int>();
            e.HasQueryFilter(c => c.TenantId == _tenant.TenantId);

            // The code is the lookup key a box presents, and it must name exactly one
            // member: two rows with one code would make a scan a coin flip on whose
            // court opens. Per tenant, because the resolver is tenant-filtered and a
            // collision across clubs is unreachable through it anyway.
            e.HasIndex(c => new { c.TenantId, c.Code }).IsUnique();

            // One code per booking, enforced — not merely read. Two phones asking for the
            // same booking's code at once both find nothing and both insert; the index
            // refuses the second, and AccessCodeService's retry then finds the first.
            // Filtered so member-ident codes, which have no booking, are unconstrained.
            // A booking never needs a second code: its code lives until the booking ends
            // plus the grace window, and nothing mints for a booking that has ended.
            e.HasIndex(c => new { c.TenantId, c.BookingId })
                .IsUnique()
                .HasFilter("\"BookingId\" IS NOT NULL");
        });
    }

    /// <summary>
    /// The append-only trail: one table for the whole product, two orders over it.
    ///
    /// <para>
    /// <b>Two indexes, deliberately.</b> The RANGE every door reader filters by is still
    /// <c>CreatedAt</c> — retention, the club's day and "the last 24 hours" are all questions
    /// about when the club HEARD — and it is the SORT that moved to
    /// <see cref="AuditLog.ScanAt"/>, so that "newest first" is true of the instants printed on
    /// screen rather than of a column nobody is looking at. A list ordered by one and filtered
    /// by the other needs both, and ordering by <c>COALESCE</c> over the jsonb instead is what
    /// the stored column exists to avoid: no index can serve it. See <see cref="AuditLog.ScanAt"/>.
    /// </para>
    ///
    /// <para>
    /// Its own method rather than another block inside <see cref="OnModelCreating"/>, because
    /// that method is measured as one function and was one line from the length gate; see
    /// <c>memory/gotchas.md</c> on the complexity tooling.
    /// </para>
    /// </summary>
    private void ConfigureAuditLog(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AuditLog>(e =>
        {
            e.ToTable("audit_log");
            e.HasKey(a => a.Id);
            e.HasIndex(a => new { a.TenantId, a.CreatedAt });
            e.HasIndex(a => new { a.TenantId, a.ScanAt });
            e.Property(a => a.Action).HasMaxLength(128).IsRequired();
            e.Property(a => a.DetailsJson).HasColumnType("jsonb");
            e.HasQueryFilter(a => a.TenantId == _tenant.TenantId);
        });
    }

    /// <summary>
    /// The undeletable admin change record.
    ///
    /// <para>
    /// <b>Four indexes, because this table is read four ways and never scanned.</b> The change
    /// view pages by time; the area filter is the console's default narrowing; "what did this
    /// admin do" is how a club monitors itself, which is the sentence GOAL item 14 asks for;
    /// and "what happened to this schedule" is the per-schedule view. Without the last two a
    /// club's own record becomes a sequential scan of a table that, by design, is never pruned.
    /// </para>
    ///
    /// <para>
    /// The immutability triggers are NOT here — they are raw SQL in
    /// <c>ProtectAdminChangeLog</c>, because EF has no model concept for one. This method
    /// configures the shape; that migration configures the promise.
    /// </para>
    /// </summary>
    private void ConfigureAdminChangeLog(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AdminChangeLog>(e =>
        {
            e.ToTable("admin_change_log");
            e.HasKey(a => a.Id);
            e.HasIndex(a => new { a.TenantId, a.OccurredAt });
            e.HasIndex(a => new { a.TenantId, a.Area, a.OccurredAt });
            e.HasIndex(a => new { a.TenantId, a.ActorUserId, a.OccurredAt });
            e.HasIndex(a => new { a.TenantId, a.SubjectKind, a.SubjectId, a.OccurredAt });
            e.Property(a => a.ActorName).HasMaxLength(255).IsRequired();
            e.Property(a => a.ActorEmail).HasMaxLength(320);
            e.Property(a => a.Area).HasMaxLength(32).IsRequired();
            e.Property(a => a.Action).HasMaxLength(64).IsRequired();
            e.Property(a => a.SubjectKind).HasMaxLength(32);
            e.Property(a => a.SubjectLabel).HasMaxLength(255);
            e.Property(a => a.Reason).HasMaxLength(512);
            e.Property(a => a.BeforeJson).HasColumnType("jsonb");
            e.Property(a => a.AfterJson).HasColumnType("jsonb");
            e.Property(a => a.RequestId).HasMaxLength(64);
            e.Property(a => a.IpAddress).HasMaxLength(64);
            e.HasQueryFilter(a => a.TenantId == _tenant.TenantId);
        });
    }

    /// <summary>
    /// Bumps <see cref="Booking.Version"/> on every modified booking, then saves.
    ///
    /// <para>
    /// Done here rather than at each call site because a concurrency token nobody remembers
    /// to increment is a concurrency token that silently does nothing. There are several
    /// places a booking's state changes — cancel, admin cancel, check-in, the no-show sweep,
    /// the lights cue, payer reassignment — and the guarantee has to hold for all of them,
    /// including the next one somebody writes.
    /// </para>
    /// </summary>
    private void BumpBookingVersions()
    {
        foreach (var entry in ChangeTracker.Entries<Booking>())
        {
            if (entry.State == EntityState.Modified)
            {
                entry.Entity.Version++;
            }
        }
    }

    /// <summary>
    /// Fills in <see cref="AuditLog.ScanAt"/> on every row being written that has not set one.
    ///
    /// <para>
    /// <b>Here for the same reason <see cref="BumpBookingVersions"/> is.</b> Four paths write
    /// door rows — the online gate decision, the offline upload, the registry, the fleet
    /// controls — and a fifth will. A sort key each of them has to remember is a sort key one of
    /// them will not, and the symptom is a row in the wrong place in a list that says it is in
    /// order, which nothing goes red about. The rule itself is <see cref="DoorTrail.ScanAtOf"/>,
    /// stated once beside the predicates that decide what a door row is.
    /// </para>
    ///
    /// <para>
    /// A value already set is left alone, so a caller that knows better than the derivation —
    /// a fixture placing a row in the past, a future importer — is believed.
    /// </para>
    /// </summary>
    private void StampAuditScanInstants()
    {
        foreach (var entry in ChangeTracker.Entries<AuditLog>())
        {
            if (entry.State != EntityState.Added || entry.Entity.ScanAt != default) continue;

            entry.Entity.ScanAt = DoorTrail.ScanAtOf(
                entry.Entity.Action, entry.Entity.DetailsJson, entry.Entity.CreatedAt);
        }
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        BumpBookingVersions();
        StampAuditScanInstants();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(
        bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        BumpBookingVersions();
        StampAuditScanInstants();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }
}
