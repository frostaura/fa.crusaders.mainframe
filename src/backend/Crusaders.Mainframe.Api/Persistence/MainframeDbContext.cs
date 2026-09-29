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
public partial class MainframeDbContext : DbContext
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

    /// <summary>Repeating court bookings — league nights, coaching blocks. GOAL item 14.</summary>
    public DbSet<BookingSchedule> BookingSchedules => Set<BookingSchedule>();

    /// <summary>Which courts each schedule occupies. A child table, not a <c>uuid[]</c>.</summary>
    public DbSet<BookingScheduleCourt> BookingScheduleCourts => Set<BookingScheduleCourt>();

    /// <summary>The single dates that do not follow a schedule's rule — skipped or re-timed.</summary>
    public DbSet<BookingScheduleException> BookingScheduleExceptions => Set<BookingScheduleException>();
    public DbSet<WebhookEndpoint> WebhookEndpoints => Set<WebhookEndpoint>();
    public DbSet<WebhookDelivery> WebhookDeliveries => Set<WebhookDelivery>();
    public DbSet<EnrolledTemplate> EnrolledTemplates => Set<EnrolledTemplate>();
    public DbSet<BiometricMatchEvent> BiometricMatchEvents => Set<BiometricMatchEvent>();
    public DbSet<PendingTopup> PendingTopups => Set<PendingTopup>();
    public DbSet<WebAuthnCredential> WebAuthnCredentials => Set<WebAuthnCredential>();
    public DbSet<AccessCode> AccessCodes => Set<AccessCode>();

    /// <summary>What the server BELIEVES each court's lights are doing. See <see cref="CourtLightState"/>.</summary>
    public DbSet<CourtLightState> CourtLightStates => Set<CourtLightState>();

    /// <summary>The IoT error log (GOAL item 7). See <see cref="DeviceError"/>.</summary>
    public DbSet<DeviceError> DeviceErrors => Set<DeviceError>();

    // GOAL item 3. Three tables rather than a column on Membership, because the goal says a
    // member may be in SEVERAL groups and "most restrictive wins" is only a real question when
    // they can be.
    public DbSet<MemberGroup> MemberGroups => Set<MemberGroup>();
    public DbSet<MemberGroupWindow> MemberGroupWindows => Set<MemberGroupWindow>();
    public DbSet<MemberGroupMember> MemberGroupMembers => Set<MemberGroupMember>();

    /// <summary>One row per person who has changed a default. See <see cref="UserPreferences"/>.</summary>
    public DbSet<UserPreferences> UserPreferences => Set<UserPreferences>();

    /// <summary>The admin notice outbox (R23). See <see cref="AdminNotification"/>.</summary>
    public DbSet<AdminNotification> AdminNotifications => Set<AdminNotification>();

    /// <summary>Each member's REF and code generation (D1). See <see cref="MemberCode"/>.</summary>
    public DbSet<MemberCode> MemberCodes => Set<MemberCode>();

    /// <summary>One row per acting use of a member code (§4.4). See <see cref="MemberCodeUse"/>.</summary>
    public DbSet<MemberCodeUse> MemberCodeUses => Set<MemberCodeUse>();

    /// <summary>D10 pay-for confirms by nonce. See <see cref="DevicePayFor"/>.</summary>
    public DbSet<DevicePayFor> DevicePayFors => Set<DevicePayFor>();

    /// <summary>D10 pay-for quotes by nonce. See <see cref="DevicePayForQuote"/>.</summary>
    public DbSet<DevicePayForQuote> DevicePayForQuotes => Set<DevicePayForQuote>();

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
        ConfigureMemberGroups(modelBuilder);
        ConfigureAccessCodes(modelBuilder);
        ConfigureCourtLightState(modelBuilder);
        ConfigureDeviceErrors(modelBuilder);
        ConfigureUserPreferences(modelBuilder);
        ConfigureAdminNotifications(modelBuilder);
        ConfigureMemberCodes(modelBuilder);
        ConfigurePlayers(modelBuilder);
        ConfigurePlay(modelBuilder);
        ConfigureSessions(modelBuilder);

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

        ConfigureBookingsAndLedger(modelBuilder);

        ConfigureAuditLog(modelBuilder);
        ConfigureAdminChangeLog(modelBuilder);
        ConfigureBookingSchedules(modelBuilder);

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

        ConfigurePendingTopups(modelBuilder);
    }

    /// <summary>
    /// The pending top-up table, lifted out of <c>OnModelCreating</c> for the same reason
    /// <see cref="ConfigureDevices"/> was: that method is at its stated 200-line ceiling and
    /// every new table lands in it.
    /// </summary>
    private void ConfigurePendingTopups(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<PendingTopup>(e =>
        {
            e.ToTable("pending_topups");
            e.HasKey(p => p.Id);
            e.HasIndex(p => new { p.TenantId, p.UserId, p.CreatedAt });
            e.HasIndex(p => p.IdempotencyKey).IsUnique();
            // Unique PER TENANT, not globally.
            //
            // This column holds a PayFast pf_payment_id, which is unique within a merchant
            // account and says nothing about any other club's. The index was global and
            // tenant-blind — the same defect D2-B02 names on ledger_entries — so two clubs on
            // one merchant account, or any two sandboxes with small repeating ids, collided
            // here: the second club's completion raised 23505 on a table the caller was not
            // even looking at, and the member was never credited for money PayFast took. Found
            // by the cross-tenant fixture for D2-B02, which the ledger-side fix alone did not
            // turn green.
            //
            // Composite rather than namespaced, unlike ledger_entries: that column is shared by
            // four reference namespaces (topup:, adjust:, walkup:, the settlement references)
            // and the prefix is what keeps them apart, whereas THIS column holds one kind of
            // value and is quoted to the member in the failure email. A prefix here would put
            // a GUID in front of the reference a member reads out over the phone.
            e.HasIndex(p => new { p.TenantId, p.ExternalReference })
                .IsUnique().HasFilter("\"ExternalReference\" IS NOT NULL");
            e.Property(p => p.AmountZar).HasColumnType("numeric(10,2)");
            // Same precision as ledger_entries.ConversionRate — the two hold the same number
            // and a narrower column here would silently round the rate the ledger then quotes.
            e.Property(p => p.ConversionRate).HasColumnType("numeric(8,4)");
            e.Property(p => p.IdempotencyKey).HasMaxLength(64).IsRequired();
            e.Property(p => p.GatewayCheckoutId).HasMaxLength(128);
            e.Property(p => p.ExternalReference).HasMaxLength(255);
            e.Property(p => p.Status).HasConversion<int>();
            e.Property(p => p.FailureReason).HasMaxLength(512);
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });
    }

    /// <summary>
    /// The three member-group tables (GOAL item 3), lifted out of <c>OnModelCreating</c> for the
    /// same reason <see cref="ConfigureDevices"/> was: that method is at its stated 200-line
    /// ceiling and every new table lands in it.
    /// </summary>
    private void ConfigureMemberGroups(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<MemberGroup>(e =>
        {
            e.ToTable("member_groups");
            e.HasKey(g => g.Id);
            e.Property(g => g.Name).HasMaxLength(GroupRules.MaxNameLength).IsRequired();
            e.Property(g => g.Description).HasMaxLength(GroupRules.MaxDescriptionLength);
            e.Property(g => g.Status).HasConversion<int>();
            e.Property(g => g.PricingMode).HasConversion<int>();
            // Same precision as courts.SlicePriceCredits: the two hold the same kind of number,
            // and a narrower column here would round a price the ledger then quotes.
            e.Property(g => g.FlatSlicePriceCredits).HasColumnType("numeric(10,2)");
            e.HasIndex(g => new { g.TenantId, g.Status });
            // Same precision as ledger_entries.ConversionRate and pending_topups.ConversionRate:
            // the rate is copied onto both verbatim, so a narrower column here would round the offer.
            e.Property(g => g.CreditsPerZar).HasColumnType("numeric(8,4)");
            e.Property(g => g.SystemKey).HasMaxLength(32);
            // One league group per club: the deprecated member_class field, the seeder and the
            // migration all find it by this key, so two of them would be two answers.
            e.HasIndex(g => new { g.TenantId, g.SystemKey })
                .IsUnique().HasFilter("\"SystemKey\" IS NOT NULL");
            // A top-up rate of zero would take a member's money and credit nothing; the API
            // refuses it and the database has the last word, as it does on the price (D2-B06).
            e.ToTable(t => t.HasCheckConstraint(
                "ck_member_groups_credits_per_zar",
                "\"CreditsPerZar\" IS NULL OR (\"CreditsPerZar\" > 0 AND \"CreditsPerZar\" <= 1000)"));
            // The database is the last place a nonsense price can be refused, which is the whole
            // lesson of D2-B06: the settings PUT was not the only way a negative one got in.
            e.ToTable(t => t.HasCheckConstraint(
                "ck_member_groups_pricing",
                "(\"PricingMode\" = 0) "
                + "OR (\"PricingMode\" = 1 AND \"PriceMultiplierBps\" BETWEEN 0 AND 1000000) "
                + "OR (\"PricingMode\" = 2 AND \"FlatSlicePriceCredits\" IS NOT NULL "
                + "AND \"FlatSlicePriceCredits\" >= 0)"));
            e.HasQueryFilter(g => g.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<MemberGroupWindow>(e =>
        {
            e.ToTable("member_group_windows");
            e.HasKey(w => w.Id);
            // The grid's read: every window of a member's groups for one weekday.
            e.HasIndex(w => new { w.TenantId, w.GroupId, w.DayOfWeek });
            e.Property(w => w.DayOfWeek).HasConversion<int>();
            // No midnight crossing: refused rather than silently wrapped, because a window that
            // wraps is two windows and nothing downstream reads it as two.
            e.ToTable(t => t.HasCheckConstraint(
                "ck_member_group_windows_range",
                "\"StartMinute\" >= 0 AND \"EndMinute\" <= 1440 AND \"EndMinute\" > \"StartMinute\""));
            e.HasQueryFilter(w => w.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<MemberGroupMember>(e =>
        {
            e.ToTable("member_group_members");
            e.HasKey(m => m.Id);
            // Makes a double-add a no-op rather than a duplicate rule.
            e.HasIndex(m => new { m.TenantId, m.GroupId, m.UserId }).IsUnique();
            // And this is the one the GRID uses, on every read of every member's own rules.
            e.HasIndex(m => new { m.TenantId, m.UserId });
            e.HasQueryFilter(m => m.TenantId == _tenant.TenantId);
        });
    }

    /// <summary>
    /// <c>user_preferences</c>, lifted out of <c>OnModelCreating</c> for the reason every table
    /// since the devices one has been: that method is at its stated 200-line ceiling.
    /// </summary>
    private void ConfigureUserPreferences(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<UserPreferences>(e =>
        {
            e.ToTable("user_preferences");
            e.HasKey(p => p.Id);
            // One row per person. The lazy create in UserPreferencesService races on a double
            // first-toggle, and this index is what turns the loser into a retry rather than a
            // second, contradictory row for the same member.
            e.HasIndex(p => new { p.TenantId, p.UserId }).IsUnique();
            e.Property(p => p.Theme).HasMaxLength(16).IsRequired().HasDefaultValue("system");
            e.Property(p => p.MemberOnboardingLastStep).HasMaxLength(UserPreferencesRules.MaxStepLength);
            e.Property(p => p.OnboardingVersion).HasDefaultValue(1);
            e.Property(p => p.Findable).HasDefaultValue(false);
            e.Property(p => p.ShowInLeaderboards).HasDefaultValue(false);
            e.Property(p => p.RatingOptIn).HasDefaultValue(false);
            e.Property(p => p.WeeklyRecap).HasDefaultValue(false);
            e.Property(p => p.ShareResults).HasDefaultValue(false);
            e.Property(p => p.AdminNotificationOptoutsJson)
                .HasColumnType("jsonb").IsRequired().HasDefaultValueSql("'[]'::jsonb");
            // The database has the last word on a theme, for the D2-B06 reason: a validator in
            // one endpoint is not the only way a value reaches a column.
            e.ToTable(t => t.HasCheckConstraint(
                "ck_user_preferences_theme", "\"Theme\" IN ('system', 'light', 'dark')"));
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });
    }

    /// <summary>
    /// The admin notice outbox, lifted out of <c>OnModelCreating</c> for the 200-line reason.
    ///
    /// <para>
    /// <b>Four indexes, one per reader.</b> The dedupe key is the outbox's whole idempotency
    /// promise, so it is unique per club and enforced here rather than checked. The dispatcher's
    /// claim reads only pending rows by due time, across every club, so its index is partial on
    /// the pending state and carries no tenant. The feed pages one club newest first. And a
    /// cooldown asks "was one of these mailed lately" per kind and scope.
    /// </para>
    /// </summary>
    private void ConfigureAdminNotifications(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AdminNotification>(e =>
        {
            e.ToTable("admin_notifications", t =>
            {
                t.HasCheckConstraint("ck_admin_notifications_state", "\"State\" BETWEEN 0 AND 3");
                t.HasCheckConstraint("ck_admin_notifications_attempts", "\"Attempts\" >= 0");
                // A member row must name its member; an admin row must not name one.
                t.HasCheckConstraint(
                    "ck_admin_notifications_audience",
                    "(\"Audience\" = 0 AND \"RecipientUserId\" IS NULL) OR (\"Audience\" = 1 AND \"RecipientUserId\" IS NOT NULL)");
            });
            e.HasKey(n => n.Id);
            e.Property(n => n.Kind).HasMaxLength(AdminNotification.KindMaxLength).IsRequired();
            e.Property(n => n.DedupeKey).HasMaxLength(AdminNotification.DedupeKeyMaxLength).IsRequired();
            e.Property(n => n.PayloadJson).HasColumnType("jsonb").IsRequired().HasDefaultValueSql("'{}'::jsonb");
            e.Property(n => n.Headline).HasMaxLength(AdminNotification.HeadlineMaxLength).IsRequired();
            e.Property(n => n.Link).HasMaxLength(AdminNotification.LinkMaxLength);
            e.Property(n => n.CooldownScope).HasMaxLength(AdminNotification.CooldownScopeMaxLength);
            e.Property(n => n.LastError).HasMaxLength(AdminNotification.LastErrorMaxLength);
            e.Property(n => n.DeliveredToJson).HasColumnType("jsonb").IsRequired().HasDefaultValueSql("'[]'::jsonb");
            e.Property(n => n.State).HasConversion<int>();
            e.Property(n => n.Audience).HasConversion<int>();

            e.HasIndex(n => new { n.TenantId, n.DedupeKey }).IsUnique();
            e.HasIndex(n => new { n.TenantId, n.CreatedAt, n.Id });
            e.HasIndex(n => new { n.TenantId, n.Kind, n.CooldownScope, n.CreatedAt });
            e.HasIndex(n => n.DueAt).HasFilter("\"State\" = 0");
            e.HasQueryFilter(n => n.TenantId == _tenant.TenantId);
        });
    }

    /// <summary>
    /// The three member-code tables (D1, D10). Every one is tenant-scoped and filtered, and each
    /// carries the unique index its correctness rests on: one REF per member and per tenant, one
    /// use per code per class, one payment per box per nonce.
    /// </summary>
    private void ConfigureMemberCodes(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<MemberCode>(e =>
        {
            e.ToTable("member_codes");
            e.HasKey(c => c.Id);
            e.HasIndex(c => new { c.TenantId, c.UserId }).IsUnique();
            e.HasIndex(c => new { c.TenantId, c.Ref }).IsUnique();
            e.Property(c => c.Generation).HasDefaultValue(1);
            e.ToTable(t =>
            {
                t.HasCheckConstraint("ck_member_codes_ref", "\"Ref\" BETWEEN 1 AND 1048575");
                t.HasCheckConstraint("ck_member_codes_generation", "\"Generation\" >= 1");
            });
            e.HasQueryFilter(c => c.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<MemberCodeUse>(e =>
        {
            e.ToTable("member_code_uses");
            e.HasKey(u => u.Id);
            e.Property(u => u.UseClass).HasMaxLength(8).IsRequired();
            e.Property(u => u.Kind).HasMaxLength(32).IsRequired();
            e.Property(u => u.ClaimKey).HasMaxLength(MemberCodeUse.ClaimKeyMaxLength);
            e.HasIndex(u => new { u.TenantId, u.Ref, u.Step, u.UseClass }).IsUnique();
            e.HasIndex(u => u.UsedAt);
            e.ToTable(t => t.HasCheckConstraint(
                "ck_member_code_uses_class", "\"UseClass\" IN ('door', 'court', 'money')"));
            e.HasQueryFilter(u => u.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<DevicePayFor>(e =>
        {
            e.ToTable("device_pay_fors");
            e.HasKey(p => p.Id);
            e.Property(p => p.Nonce).HasMaxLength(32).IsRequired();
            e.Property(p => p.AmountLabel).HasMaxLength(16).IsRequired();
            e.Property(p => p.AmountCredits).HasColumnType("numeric(10,2)");
            e.Property(p => p.BalanceAfterCredits).HasColumnType("numeric(10,2)");
            e.HasIndex(p => new { p.TenantId, p.DeviceId, p.Nonce }).IsUnique();
            e.HasQueryFilter(p => p.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<DevicePayForQuote>(e =>
        {
            e.ToTable("device_pay_for_quotes");
            e.HasKey(q => q.Id);
            e.Property(q => q.Nonce).HasMaxLength(32).IsRequired();
            e.HasIndex(q => new { q.TenantId, q.DeviceId, q.Nonce }).IsUnique();
            e.HasIndex(q => q.QuotedAt);
            e.HasQueryFilter(q => q.TenantId == _tenant.TenantId);
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
            // Latest heartbeat's `caps` (member-code rollout). An empty array, never null, for a
            // board that named nothing — see Device.Capabilities.
            e.Property(d => d.Capabilities).HasColumnType("text[]").IsRequired().HasDefaultValueSql("'{}'::text[]");
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
    /// <summary>
    /// The two tables the money model hangs off, configured together.
    ///
    /// <para>
    /// Extracted from <c>OnModelCreating</c> when the schedule and trace indexes pushed it
    /// past the complexity gate's 200-line ceiling. They belong together for a reason
    /// beyond arithmetic: a booking row and its ledger row flush in one unit of work, and
    /// the concurrency token on one is what makes the other safe.
    /// </para>
    /// </summary>
    private void ConfigureBookingsAndLedger(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Booking>(e =>
        {
            e.ToTable("bookings");
            e.HasKey(b => b.Id);
            e.HasIndex(b => new { b.TenantId, b.CourtId, b.StartsAt });
            e.HasIndex(b => new { b.TenantId, b.UserId, b.StartsAt });
            // D11: the players sweeps (holds, lapse, reminders) select bookings by their frozen deadline.
            e.HasIndex(b => new { b.TenantId, b.ShareDeadlineAt }).HasFilter("\"ShareDeadlineAt\" IS NOT NULL");
            // ...and the bookings a failed reconcile left due: a handful, found without a scan.
            e.HasIndex(b => new { b.TenantId, b.ShareReconcileDueAt }).HasFilter("\"ShareReconcileDueAt\" IS NOT NULL");
            // D14: the play recompute markers a change staged — a handful, drained without a scan.
            e.HasIndex(b => new { b.TenantId, b.PlayRecomputeDueAt }).HasFilter("\"PlayRecomputeDueAt\" IS NOT NULL");
            e.Property(b => b.AmountChargedCredits).HasColumnType("numeric(10,2)");
            e.Property(b => b.Status).HasConversion<int>();
            // How "edit this and future" finds an occurrence's rows, and how the grid learns
            // which league night a block belongs to. StartsAt last so the index also serves
            // "everything this schedule has ahead of now".
            e.HasIndex(b => new { b.TenantId, b.ScheduleId, b.StartsAt });
            e.Property(b => b.AdminNote).HasMaxLength(128);
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

            // The night trace asks "what did this person do" in BOTH directions — as the
            // subject of a movement and as the actor of one — because an admin adjusting
            // somebody's credits belongs on that member's night AND on the admin's own. The
            // subject half is served by the index above; without this one the actor half is a
            // sequential scan of the club's entire ledger.
            e.HasIndex(l => new { l.TenantId, l.ActorUserId, l.CreatedAt });

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
    }

    private void ConfigureAuditLog(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AuditLog>(e =>
        {
            e.ToTable("audit_log");
            e.HasKey(a => a.Id);
            e.HasIndex(a => new { a.TenantId, a.CreatedAt });
            e.HasIndex(a => new { a.TenantId, a.ScanAt });

            // The night trace's two halves, and the change view's actor filter.
            //
            // audit_log had exactly one index — (TenantId, CreatedAt) — and grows for ever for
            // every non-door action, because retention_years only NULLS the subject rather than
            // deleting the row. Asking it "everything about this person on this night" without
            // these is a full scan of the club's whole history, twice, per request.
            e.HasIndex(a => new { a.TenantId, a.SubjectUserId, a.CreatedAt });
            e.HasIndex(a => new { a.TenantId, a.ActorUserId, a.CreatedAt });

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
    /// Repeating bookings — the rule, the courts it occupies, and the dates that break it.
    ///
    /// <para>
    /// <b>The CHECK constraints are on the database and not only in the validator.</b> An
    /// occurrence expander reading <c>EndMinute &lt;= StartMinute</c> produces a negative-length
    /// block, and a <c>DaysOfWeek</c> of zero produces a schedule that materialises nothing and
    /// reports success — both of which are the shape of <c>peak_hours</c>' "validated one way and
    /// read another" defect, which left peak protection silently off for every Regular member
    /// with no error anywhere. The PUT is not the only way a value reaches a column.
    /// </para>
    /// </summary>
    private void ConfigureBookingSchedules(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<BookingSchedule>(e =>
        {
            e.ToTable("booking_schedules", t =>
            {
                t.HasCheckConstraint(
                    "ck_booking_schedules_time_range",
                    $"\"EndMinute\" > \"StartMinute\" AND \"EndMinute\" <= {BookingSchedule.MinutesPerDay} AND \"StartMinute\" >= 0");
                t.HasCheckConstraint(
                    "ck_booking_schedules_days",
                    $"\"DaysOfWeek\" BETWEEN {BookingSchedule.SundayBit} AND {BookingSchedule.AllDays}");
                t.HasCheckConstraint(
                    "ck_booking_schedules_interval",
                    $"\"IntervalWeeks\" BETWEEN 1 AND {BookingSchedule.MaxIntervalWeeks}");
            });
            e.HasKey(s => s.Id);
            e.HasIndex(s => new { s.TenantId, s.Status });
            e.Property(s => s.Name).HasMaxLength(128).IsRequired();
            e.Property(s => s.Label).HasMaxLength(128).IsRequired();
            e.Property(s => s.Status).HasConversion<int>();
            e.HasQueryFilter(s => s.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<BookingScheduleCourt>(e =>
        {
            e.ToTable("booking_schedule_courts");
            e.HasKey(c => c.Id);
            e.HasIndex(c => new { c.TenantId, c.ScheduleId, c.CourtId }).IsUnique();
            e.HasQueryFilter(c => c.TenantId == _tenant.TenantId);
        });

        modelBuilder.Entity<BookingScheduleException>(e =>
        {
            e.ToTable("booking_schedule_exceptions");
            e.HasKey(x => x.Id);
            // One exception per date: a date that is both skipped and re-timed is two
            // contradictory instructions, and the database is the only place that can refuse the
            // second one when two admins send them at once.
            e.HasIndex(x => new { x.TenantId, x.ScheduleId, x.OccurrenceDate }).IsUnique();
            e.Property(x => x.Kind).HasConversion<int>();
            e.Property(x => x.Reason).HasMaxLength(512);
            e.HasQueryFilter(x => x.TenantId == _tenant.TenantId);
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

        // The same guarantee for a booking's seats (D11): an accept, a withdrawal and an
        // organiser's removal race on one row, and the loser must match nothing.
        foreach (var entry in ChangeTracker.Entries<BookingParticipant>())
        {
            if (entry.State == EntityState.Modified)
            {
                entry.Entity.Version++;
            }
        }

        // And for a match result (D14): a confirm, a dispute, the auto-confirm sweep and an admin
        // void race on one row; the version is also the client's expectedVersion.
        foreach (var entry in ChangeTracker.Entries<MatchResult>())
        {
            if (entry.State == EntityState.Modified)
            {
                entry.Entity.Version++;
            }
        }
        foreach (var entry in ChangeTracker.Entries<MemberPlayProfile>())
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

    /// <summary>
    /// The server's belief about each court's relay — one row per court, never per event.
    ///
    /// <para>
    /// Its own method rather than another block in <see cref="OnModelCreating"/>, for the
    /// length reason the devices and the audit log are already lifted out for.
    /// </para>
    /// </summary>
    private void ConfigureCourtLightState(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<CourtLightState>(e =>
        {
            e.ToTable("court_light_state");

            // Composite key on (tenant, court) rather than a surrogate id. The table holds
            // exactly one row per court by construction, and a surrogate would permit two —
            // which is the state where the control board and the restore answer disagree and
            // neither is wrong.
            e.HasKey(s => new { s.TenantId, s.CourtId });

            e.Property(s => s.State).HasConversion<int>();
            e.Property(s => s.Cause).HasConversion<int>();

            // NO HasDefaultValue, AND THAT IS A CORRECTION RATHER THAN AN OMISSION.
            //
            // Existing rows must read Unknown — see the migration, which backfills them and
            // then DROPS the database default. Declaring the default on the MODEL as well
            // looks harmless and is not: EF omits a property from the INSERT whenever its
            // value equals the CLR default, and the CLR default of this enum is 0, which is
            // LightState.Off. So every genuine "the box reports this relay is open" was
            // silently dropped from the statement and the database wrote its own default
            // instead — the row said Unknown while the box had plainly just said Off. Caught
            // by the relay-report test, which is the only place the two disagree visibly.
            e.Property(s => s.ConfirmedState).HasConversion<int>();
            e.HasQueryFilter(s => s.TenantId == _tenant.TenantId);

            // The control board reads every row for the tenant in one go, and the restore
            // answer reads the handful a device drives. The primary key already serves the
            // first; this serves the second without a scan per heartbeat.
            e.HasIndex(s => new { s.TenantId, s.DeviceId });
        });
    }

    /// <summary>
    /// The IoT error log. See <see cref="DeviceError"/> for why de-duplication is a uniqueness
    /// rule about the present rather than a read-then-write.
    /// </summary>
    private void ConfigureDeviceErrors(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<DeviceError>(e =>
        {
            e.ToTable("device_errors");
            e.HasKey(r => r.Id);
            e.HasQueryFilter(r => r.TenantId == _tenant.TenantId);

            e.Property(r => r.Code).HasMaxLength(DeviceError.MaxCodeLength).IsRequired();
            e.Property(r => r.Fingerprint).HasMaxLength(DeviceError.MaxFingerprintLength).IsRequired();
            e.Property(r => r.Detail).HasMaxLength(DeviceError.MaxDetailLength);
            e.Property(r => r.ResolutionNote).HasMaxLength(DeviceError.MaxDetailLength);
            e.Property(r => r.ClaimedDeviceCode).HasMaxLength(DeviceError.MaxClaimedDeviceCodeLength);
            e.Property(r => r.ClaimedMac).HasMaxLength(DeviceError.MaxClaimedMacLength);
            e.Property(r => r.Source).HasConversion<int>();
            e.Property(r => r.Severity).HasConversion<int>();

            // The monitoring list, newest first, keyset-paged.
            e.HasIndex(r => new { r.TenantId, r.LastSeenAt });

            // The per-board feed, and the control board's open-error count per device.
            e.HasIndex(r => new { r.TenantId, r.DeviceId, r.LastSeenAt });

            // The summary's counts.
            e.HasIndex(r => new { r.TenantId, r.Severity, r.ResolvedAt });

            // ONE OPEN ROW PER DISTINCT FAULT. Exactly the DeviceOutage pattern above, for
            // exactly its stated reason: this makes de-duplication a rule the database
            // enforces about the present, rather than a check-then-insert that two concurrent
            // reports both pass. Resolved rows fall out of the filter, so history accumulates
            // freely and a fault that returns in month four opens a fresh row with a truthful
            // FirstSeenAt rather than resurrecting a stale one.
            e.HasIndex(r => new { r.TenantId, r.Fingerprint })
                .IsUnique()
                .HasFilter("\"ResolvedAt\" IS NULL");

            // The enum-range guard ledger_entries already carries, and a count that cannot be
            // zero: a row standing for no occurrences is a row that should not exist, and the
            // upsert's `Count = Count + EXCLUDED.Count` has no other floor.
            e.ToTable(t =>
            {
                t.HasCheckConstraint("ck_device_errors_count", "\"Count\" >= 1");
                t.HasCheckConstraint("ck_device_errors_severity", "\"Severity\" BETWEEN 0 AND 3");
            });
        });
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        BumpBookingVersions();
        StampAuditScanInstants();
        return SaveStaging(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(
        bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        BumpBookingVersions();
        StampAuditScanInstants();
        return SaveStagingAsync(acceptAllChangesOnSuccess, cancellationToken);
    }
}
