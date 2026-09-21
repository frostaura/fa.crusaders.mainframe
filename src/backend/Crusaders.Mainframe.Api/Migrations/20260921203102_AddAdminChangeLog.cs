using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// The club's undeletable admin change record — the table only. Its immutability is the
    /// next migration's, <c>ProtectAdminChangeLog</c>, because a trigger has no EF model
    /// concept and the two are separately deployable.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Hand-trimmed, and the reason matters to the next person who scaffolds a migration
    /// on this branch.</b> The designer snapshot beside
    /// <c>20260921190452_AddDeviceEventReceiptBootId</c> was written on a branch that did not
    /// carry <c>20260921185533_AddDoorTruthColumns</c>, so it is missing
    /// <c>audit_log.ScanAt</c>, <c>devices.EventsLost</c>, <c>devices.EventsLostReportedAt</c>,
    /// <c>devices.ShutHeardAt</c> and <c>device_outages.EndedByContact</c>. Every migration
    /// scaffolded against it therefore proposes to ADD those five columns a second time, which
    /// on a fresh database is a duplicate-column failure in the middle of the chain. Those
    /// operations were removed from this file by hand; this migration's OWN designer snapshot
    /// is complete, so the drift ends here and a migration scaffolded after this one needs no
    /// trimming.
    /// </para>
    /// </remarks>
    public partial class AddAdminChangeLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "admin_change_log",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    OccurredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ActorUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ActorName = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    ActorEmail = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true),
                    Area = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Action = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SubjectKind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    SubjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    SubjectLabel = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    Reason = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    BeforeJson = table.Column<string>(type: "jsonb", nullable: true),
                    AfterJson = table.Column<string>(type: "jsonb", nullable: true),
                    RequestId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    IpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_admin_change_log", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_admin_change_log_TenantId_ActorUserId_OccurredAt",
                table: "admin_change_log",
                columns: new[] { "TenantId", "ActorUserId", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_admin_change_log_TenantId_Area_OccurredAt",
                table: "admin_change_log",
                columns: new[] { "TenantId", "Area", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_admin_change_log_TenantId_OccurredAt",
                table: "admin_change_log",
                columns: new[] { "TenantId", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_admin_change_log_TenantId_SubjectKind_SubjectId_OccurredAt",
                table: "admin_change_log",
                columns: new[] { "TenantId", "SubjectKind", "SubjectId", "OccurredAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "admin_change_log");
        }
    }
}
