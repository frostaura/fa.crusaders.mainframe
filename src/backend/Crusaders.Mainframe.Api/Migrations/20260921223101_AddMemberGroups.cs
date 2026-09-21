using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// GOAL item 3's three tables: a group, its allowed windows, and who is in it.
    ///
    /// <para>
    /// Additive and inert. Nothing reads a group until an admin creates one and puts somebody in
    /// it, and the seeded pair (see <c>MemberGroupSeeder</c>) is deliberately unrestricted and
    /// inheriting — so applying this changes NOTHING for an existing club. That is not a
    /// courtesy: it is what makes installing a pricing and access feature on a live money system
    /// a no-op rather than a migration of the club's economics.
    /// </para>
    ///
    /// <para>
    /// The two CHECK constraints are the database having the last word on a nonsense
    /// configuration, which is the lesson of D2-B06 — a negative price reached the column through
    /// a validator that did not exist, and the court POST then seeded new courts from it.
    /// </para>
    /// </summary>
    public partial class AddMemberGroups : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "member_group_members",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    AddedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    AddedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_group_members", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "member_group_windows",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    DayOfWeek = table.Column<int>(type: "integer", nullable: false),
                    StartMinute = table.Column<int>(type: "integer", nullable: false),
                    EndMinute = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_group_windows", x => x.Id);
                    table.CheckConstraint("ck_member_group_windows_range", "\"StartMinute\" >= 0 AND \"EndMinute\" <= 1440 AND \"EndMinute\" > \"StartMinute\"");
                });

            migrationBuilder.CreateTable(
                name: "member_groups",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Description = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    PricingMode = table.Column<int>(type: "integer", nullable: false),
                    PriceMultiplierBps = table.Column<int>(type: "integer", nullable: false),
                    FlatSlicePriceCredits = table.Column<decimal>(type: "numeric(10,2)", nullable: true),
                    MaxSlotsPerDay = table.Column<int>(type: "integer", nullable: true),
                    MaxMinutesPerDay = table.Column<int>(type: "integer", nullable: true),
                    AdvanceBookingDays = table.Column<int>(type: "integer", nullable: true),
                    IsSystemDefault = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_groups", x => x.Id);
                    table.CheckConstraint("ck_member_groups_pricing", "(\"PricingMode\" = 0) OR (\"PricingMode\" = 1 AND \"PriceMultiplierBps\" BETWEEN 0 AND 1000000) OR (\"PricingMode\" = 2 AND \"FlatSlicePriceCredits\" IS NOT NULL AND \"FlatSlicePriceCredits\" >= 0)");
                });

            migrationBuilder.CreateIndex(
                name: "IX_member_group_members_TenantId_GroupId_UserId",
                table: "member_group_members",
                columns: new[] { "TenantId", "GroupId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_group_members_TenantId_UserId",
                table: "member_group_members",
                columns: new[] { "TenantId", "UserId" });

            migrationBuilder.CreateIndex(
                name: "IX_member_group_windows_TenantId_GroupId_DayOfWeek",
                table: "member_group_windows",
                columns: new[] { "TenantId", "GroupId", "DayOfWeek" });

            migrationBuilder.CreateIndex(
                name: "IX_member_groups_TenantId_Status",
                table: "member_groups",
                columns: new[] { "TenantId", "Status" });

            // Case-insensitively unique per tenant, which EF cannot express: two groups called
            // "League" and "league" is an admin reading the wrong rule and a member charged by it.
            migrationBuilder.Sql(
                """
                CREATE UNIQUE INDEX "IX_member_groups_TenantId_LowerName"
                    ON member_groups ("TenantId", lower("Name"));
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""DROP INDEX IF EXISTS "IX_member_groups_TenantId_LowerName";""");

            migrationBuilder.DropTable(
                name: "member_group_members");

            migrationBuilder.DropTable(
                name: "member_group_windows");

            migrationBuilder.DropTable(
                name: "member_groups");
        }
    }
}
