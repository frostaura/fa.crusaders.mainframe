using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// The four columns round three needed, and the backfills that make them true of the rows
    /// that were already there.
    ///
    /// <para>
    /// <c>devices.ShutHeardAt</c> (R3-1) — whether a shut door has HEARD it is shut.
    /// <c>devices.EventsLost</c> / <c>EventsLostReportedAt</c> (R3-33) — the board's own count of
    /// records its queue overwrote. <c>device_outages.EndedByContact</c> (R3-2) — whether a
    /// closed outage's end is an instant anybody actually heard from the board.
    /// <c>audit_log.ScanAt</c> (R3-17) — the instant a row is displayed AND ordered by, so that
    /// "newest first" is true of an offline scan delivered hours after it happened.
    /// </para>
    ///
    /// <para>
    /// <b>The two backfills are not optional.</b> A new NOT NULL column on an append-only table
    /// arrives holding its type's default on every existing row, and both of these are read as
    /// facts: an un-backfilled <c>ScanAt</c> would sort a club's entire history to the bottom of
    /// its own log, and an un-backfilled <c>EndedByContact</c> would tell the no-show waiver that
    /// no outage in the club's history was ever witnessed.
    /// </para>
    /// </summary>
    public partial class AddDoorTruthColumns : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "EventsLost",
                table: "devices",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "EventsLostReportedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ShutHeardAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            // TRUE for every row that already exists, which is the status quo reading: the
            // health sweep and the heartbeat wrote nearly all of them and both close on real
            // contact. The handful closed by an out-of-service switch cannot be told apart
            // retrospectively, and leaving them claiming contact is the conservative direction
            // — it is what the code believed yesterday. The DDL default matches the entity's
            // own initializer so the two cannot disagree.
            migrationBuilder.AddColumn<bool>(
                name: "EndedByContact",
                table: "device_outages",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ScanAt",
                table: "audit_log",
                type: "timestamp with time zone",
                nullable: false,
                defaultValue: new DateTimeOffset(new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)));

            // Every existing row is displayed at the instant it was created…
            migrationBuilder.Sql(@"UPDATE audit_log SET ""ScanAt"" = ""CreatedAt""");

            // …except an offline door scan, which was created at the UPLOAD and carries the
            // scan's own instant in its details. Narrowed to the two actions that can have one
            // and guarded three ways — the key present, its value a JSON string, and that string
            // shaped like an ISO date — because `text::timestamptz` on anything else aborts the
            // whole migration, and a schema change that cannot be applied is worse than a
            // handful of rows keeping their delivery instant. See AuditLog.ScanAt.
            migrationBuilder.Sql(@"
                UPDATE audit_log
                   SET ""ScanAt"" = (""DetailsJson""->>'occurred_at')::timestamptz
                 WHERE ""Action"" IN ('device.gate_open', 'device.unknown_scan')
                   AND ""DetailsJson"" IS NOT NULL
                   AND jsonb_typeof(""DetailsJson""->'occurred_at') = 'string'
                   AND (""DetailsJson""->>'occurred_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'");

            migrationBuilder.CreateIndex(
                name: "IX_audit_log_TenantId_ScanAt",
                table: "audit_log",
                columns: new[] { "TenantId", "ScanAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_audit_log_TenantId_ScanAt",
                table: "audit_log");

            migrationBuilder.DropColumn(
                name: "EventsLost",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "EventsLostReportedAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "ShutHeardAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "EndedByContact",
                table: "device_outages");

            migrationBuilder.DropColumn(
                name: "ScanAt",
                table: "audit_log");
        }
    }
}
