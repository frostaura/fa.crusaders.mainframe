using Microsoft.EntityFrameworkCore.Migrations;

namespace Crusaders.Mainframe.Api.Migrations;

/// <summary>
/// Initial schema for crusaders.mainframe — written by hand with raw SQL because the project
/// was scaffolded without a host .NET toolchain available. Once you have <c>dotnet ef</c>
/// running locally, you can regenerate this with:
///
///   dotnet ef migrations remove --force
///   dotnet ef migrations add Initial
///
/// The hand-written form is intentionally faithful to <see cref="Persistence.MainframeDbContext.OnModelCreating"/>
/// so the regenerated migration will produce a no-op diff against the live schema.
/// </summary>
public partial class InitialCreate : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql(@"
            CREATE TABLE tenants (
                ""Id"" uuid PRIMARY KEY,
                ""Slug"" varchar(64) NOT NULL,
                ""DisplayName"" varchar(255) NOT NULL,
                ""Status"" varchar(32) NOT NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE UNIQUE INDEX ""IX_tenants_Slug"" ON tenants (""Slug"");

            CREATE TABLE tenant_settings (
                ""TenantId"" uuid PRIMARY KEY,
                ""SettingsJson"" jsonb NOT NULL,
                ""UpdatedAt"" timestamptz NOT NULL
            );

            CREATE TABLE users (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""Email"" varchar(320) NOT NULL,
                ""PasswordHash"" text NULL,
                ""EmailVerified"" boolean NOT NULL,
                ""IsAdmin"" boolean NOT NULL,
                ""IsPlatformAdmin"" boolean NOT NULL,
                ""Status"" varchar(32) NOT NULL,
                ""CreatedAt"" timestamptz NOT NULL,
                ""LastLoginAt"" timestamptz NULL
            );
            CREATE UNIQUE INDEX ""IX_users_TenantId_Email"" ON users (""TenantId"", ""Email"");

            CREATE TABLE memberships (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""UserId"" uuid NOT NULL,
                ""FullName"" varchar(255) NOT NULL,
                ""MembershipNumber"" varchar(64) NOT NULL,
                ""PhotoUrl"" varchar(1024) NULL,
                ""Status"" integer NOT NULL,
                ""RejectionReason"" text NULL,
                ""ReviewedByUserId"" uuid NULL,
                ""ReviewedAt"" timestamptz NULL,
                ""CreatedAt"" timestamptz NOT NULL,
                CONSTRAINT ""FK_memberships_users_UserId"" FOREIGN KEY (""UserId"") REFERENCES users (""Id"") ON DELETE CASCADE
            );
            CREATE UNIQUE INDEX ""IX_memberships_TenantId_MembershipNumber"" ON memberships (""TenantId"", ""MembershipNumber"");
            CREATE UNIQUE INDEX ""IX_memberships_UserId"" ON memberships (""UserId"");

            CREATE TABLE auth_tokens (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""UserId"" uuid NOT NULL,
                ""Kind"" integer NOT NULL,
                ""TokenHash"" varchar(128) NOT NULL,
                ""ExpiresAt"" timestamptz NOT NULL,
                ""UsedAt"" timestamptz NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE INDEX ""IX_auth_tokens_TokenHash"" ON auth_tokens (""TokenHash"");

            CREATE TABLE courts (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""CourtNumber"" integer NOT NULL,
                ""Name"" varchar(128) NOT NULL,
                ""CourtType"" integer NOT NULL,
                ""SlicePriceZar"" numeric(10,2) NOT NULL,
                ""IsActive"" boolean NOT NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE UNIQUE INDEX ""IX_courts_TenantId_CourtNumber"" ON courts (""TenantId"", ""CourtNumber"");

            CREATE TABLE bookings (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""CourtId"" uuid NOT NULL,
                ""UserId"" uuid NULL,
                ""ActorUserId"" uuid NOT NULL,
                ""StartsAt"" timestamptz NOT NULL,
                ""EndsAt"" timestamptz NOT NULL,
                ""SliceMinutes"" integer NOT NULL,
                ""SliceCount"" integer NOT NULL,
                ""AmountChargedZar"" numeric(10,2) NOT NULL,
                ""Status"" integer NOT NULL,
                ""BlockLabel"" varchar(128) NULL,
                ""CancelledAt"" timestamptz NULL,
                ""CancellationReason"" varchar(512) NULL,
                ""CancellationPenaltyWaived"" boolean NOT NULL,
                ""LightsOnCuedAt"" timestamptz NULL,
                ""LightsOffCuedAt"" timestamptz NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE INDEX ""IX_bookings_TenantId_CourtId_StartsAt"" ON bookings (""TenantId"", ""CourtId"", ""StartsAt"");
            CREATE INDEX ""IX_bookings_TenantId_UserId_StartsAt"" ON bookings (""TenantId"", ""UserId"", ""StartsAt"");

            CREATE TABLE ledger_entries (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""UserId"" uuid NOT NULL,
                ""Type"" integer NOT NULL,
                ""AmountZar"" numeric(10,2) NOT NULL,
                ""RelatedBookingId"" uuid NULL,
                ""ActorUserId"" uuid NOT NULL,
                ""Reason"" varchar(512) NULL,
                ""ExternalReference"" varchar(255) NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE INDEX ""IX_ledger_entries_TenantId_UserId_CreatedAt"" ON ledger_entries (""TenantId"", ""UserId"", ""CreatedAt"");
            CREATE UNIQUE INDEX ""IX_ledger_entries_ExternalReference"" ON ledger_entries (""ExternalReference"") WHERE external_reference IS NOT NULL;

            CREATE TABLE audit_log (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""ActorUserId"" uuid NOT NULL,
                ""SubjectUserId"" uuid NULL,
                ""Action"" varchar(128) NOT NULL,
                ""DetailsJson"" jsonb NULL,
                ""IpAddress"" text NULL,
                ""UserAgent"" text NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE INDEX ""IX_audit_log_TenantId_CreatedAt"" ON audit_log (""TenantId"", ""CreatedAt"");

            CREATE TABLE webhook_endpoints (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""OwnerKind"" integer NOT NULL,
                ""OwnerUserId"" uuid NULL,
                ""UrlTemplate"" varchar(2048) NOT NULL,
                ""EventFilter"" varchar(1024) NOT NULL,
                ""Secret"" varchar(128) NOT NULL,
                ""Enabled"" boolean NOT NULL,
                ""Description"" varchar(255) NULL,
                ""FailureCount"" integer NOT NULL,
                ""LastSuccessAt"" timestamptz NULL,
                ""LastFailureAt"" timestamptz NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE INDEX ""IX_webhook_endpoints_TenantId_OwnerKind"" ON webhook_endpoints (""TenantId"", ""OwnerKind"");

            CREATE TABLE webhook_deliveries (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""EndpointId"" uuid NOT NULL,
                ""EventId"" varchar(64) NOT NULL,
                ""EventType"" varchar(64) NOT NULL,
                ""Url"" varchar(2048) NOT NULL,
                ""RequestBody"" text NOT NULL,
                ""ResponseStatus"" integer NULL,
                ""ResponseBodyExcerpt"" text NULL,
                ""LatencyMs"" integer NOT NULL,
                ""Attempt"" integer NOT NULL,
                ""NextRetryAt"" timestamptz NULL,
                ""FinalState"" varchar(16) NOT NULL,
                ""CreatedAt"" timestamptz NOT NULL
            );
            CREATE INDEX ""IX_webhook_deliveries_TenantId_EndpointId_CreatedAt"" ON webhook_deliveries (""TenantId"", ""EndpointId"", ""CreatedAt"");

            CREATE TABLE enrolled_templates (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""UserId"" uuid NOT NULL,
                ""TemplateId"" varchar(128) NOT NULL,
                ""FingerLabel"" varchar(64) NULL,
                ""EnrolledByAdminUserId"" uuid NOT NULL,
                ""ConsentReceiptHash"" varchar(128) NULL,
                ""CreatedAt"" timestamptz NOT NULL,
                ""SupersededAt"" timestamptz NULL
            );
            CREATE INDEX ""IX_enrolled_templates_TenantId_UserId"" ON enrolled_templates (""TenantId"", ""UserId"");

            CREATE TABLE biometric_match_events (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""CourtId"" uuid NOT NULL,
                ""AttemptedAt"" timestamptz NOT NULL,
                ""MatchedUserId"" uuid NULL,
                ""BookingId"" uuid NULL,
                ""Confidence"" double precision NOT NULL,
                ""LivenessScore"" double precision NOT NULL,
                ""LatencyMs"" integer NOT NULL,
                ""Outcome"" varchar(32) NOT NULL
            );
            CREATE INDEX ""IX_biometric_match_events_TenantId_CourtId_AttemptedAt"" ON biometric_match_events (""TenantId"", ""CourtId"", ""AttemptedAt"");

            CREATE TABLE pending_topups (
                ""Id"" uuid PRIMARY KEY,
                ""TenantId"" uuid NOT NULL,
                ""UserId"" uuid NOT NULL,
                ""AmountZar"" numeric(10,2) NOT NULL,
                ""IdempotencyKey"" varchar(64) NOT NULL,
                ""PeachCheckoutId"" varchar(128) NULL,
                ""ExternalReference"" varchar(255) NULL,
                ""Status"" integer NOT NULL,
                ""FailureReason"" varchar(512) NULL,
                ""CreatedAt"" timestamptz NOT NULL,
                ""CompletedAt"" timestamptz NULL
            );
            CREATE INDEX ""IX_pending_topups_TenantId_UserId_CreatedAt"" ON pending_topups (""TenantId"", ""UserId"", ""CreatedAt"");
            CREATE UNIQUE INDEX ""IX_pending_topups_IdempotencyKey"" ON pending_topups (""IdempotencyKey"");
            CREATE UNIQUE INDEX ""IX_pending_topups_ExternalReference"" ON pending_topups (""ExternalReference"") WHERE external_reference IS NOT NULL;
        ");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql(@"
            DROP TABLE IF EXISTS pending_topups;
            DROP TABLE IF EXISTS biometric_match_events;
            DROP TABLE IF EXISTS enrolled_templates;
            DROP TABLE IF EXISTS webhook_deliveries;
            DROP TABLE IF EXISTS webhook_endpoints;
            DROP TABLE IF EXISTS audit_log;
            DROP TABLE IF EXISTS ledger_entries;
            DROP TABLE IF EXISTS bookings;
            DROP TABLE IF EXISTS courts;
            DROP TABLE IF EXISTS auth_tokens;
            DROP TABLE IF EXISTS memberships;
            DROP TABLE IF EXISTS users;
            DROP TABLE IF EXISTS tenant_settings;
            DROP TABLE IF EXISTS tenants;
        ");
    }
}
