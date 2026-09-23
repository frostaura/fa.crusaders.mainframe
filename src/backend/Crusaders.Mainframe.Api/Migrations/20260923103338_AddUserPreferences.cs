using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// <c>user_preferences</c>: one row per person who has changed a default — theme,
    /// onboarding progress, the privacy opt-ins and an admin's notification opt-outs.
    ///
    /// <para>
    /// Additive and inert. No row is backfilled: the read path answers the defaults for a person
    /// with no row, so applying this changes nothing any member sees until they change something
    /// themselves. Every privacy flag defaults to false in the column as well as in the code, so
    /// a row written by anything other than the service still starts invisible.
    /// </para>
    ///
    /// <para>
    /// The theme CHECK is the database having the last word, the D2-B06 lesson again: the PUT's
    /// validator is not the only road to a column.
    /// </para>
    /// </summary>
    public partial class AddUserPreferences : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "user_preferences",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Theme = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "system"),
                    MemberOnboardingCompletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    MemberOnboardingDismissedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    MemberOnboardingLastStep = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    AdminOnboardingCompletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    OnboardingVersion = table.Column<int>(type: "integer", nullable: false, defaultValue: 1),
                    Findable = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    ShowInLeaderboards = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    RatingOptIn = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    WeeklyRecap = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    AdminNotificationOptoutsJson = table.Column<string>(type: "jsonb", nullable: false, defaultValueSql: "'[]'::jsonb"),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_preferences", x => x.Id);
                    table.CheckConstraint("ck_user_preferences_theme", "\"Theme\" IN ('system', 'light', 'dark')");
                });

            migrationBuilder.CreateIndex(
                name: "IX_user_preferences_TenantId_UserId",
                table: "user_preferences",
                columns: new[] { "TenantId", "UserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_preferences");
        }
    }
}
