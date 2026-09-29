using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddPlay : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "PlayRecomputeDueAt",
                table: "bookings",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "match_results",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    BookingId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Format = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    GamesJson = table.Column<string>(type: "jsonb", nullable: false),
                    GamesWonA = table.Column<short>(type: "smallint", nullable: false),
                    GamesWonB = table.Column<short>(type: "smallint", nullable: false),
                    WinnerSide = table.Column<string>(type: "character(1)", nullable: false),
                    SubmittedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    RecordedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    SubmittedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    EditedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ConfirmDueAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ConfirmedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ConfirmedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    AutoConfirmed = table.Column<bool>(type: "boolean", nullable: false),
                    DisputedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    DisputedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    DisputeNote = table.Column<string>(type: "character varying(280)", maxLength: 280, nullable: true),
                    ClosedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ClosedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    CloseReason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    IdempotencyKey = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_match_results", x => x.Id);
                    table.CheckConstraint("ck_match_results_format", "\"Format\" IN ('best_of_3','best_of_5')");
                    table.CheckConstraint("ck_match_results_games_won", "\"GamesWonA\" <> \"GamesWonB\"");
                    table.CheckConstraint("ck_match_results_status", "\"Status\" IN ('pending','confirmed','disputed','voided','withdrawn')");
                    table.CheckConstraint("ck_match_results_winner", "\"WinnerSide\" IN ('a','b')");
                    table.ForeignKey(
                        name: "FK_match_results_bookings_BookingId",
                        column: x => x.BookingId,
                        principalTable: "bookings",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "member_badges",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    BadgeKey = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: false),
                    AwardedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    BookingId = table.Column<Guid>(type: "uuid", nullable: true),
                    ResultId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_badges", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "member_play_profiles",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    MonthlyGoalMinutes = table.Column<int>(type: "integer", nullable: true),
                    CelebrationsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    EvaluatorVersion = table.Column<int>(type: "integer", nullable: false),
                    EvaluatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_play_profiles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "member_streak_pauses",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    EndedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_streak_pauses", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "play_celebrations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    DedupeKey = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    BadgeKey = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: true),
                    Month = table.Column<string>(type: "character varying(7)", maxLength: 7, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    SeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_play_celebrations", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "match_result_players",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    ResultId = table.Column<Guid>(type: "uuid", nullable: false),
                    Side = table.Column<string>(type: "character(1)", nullable: false),
                    Position = table.Column<short>(type: "smallint", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    ParticipantId = table.Column<Guid>(type: "uuid", nullable: true),
                    GuestName = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_match_result_players", x => x.Id);
                    table.CheckConstraint("ck_match_result_players_position", "\"Position\" IN (1, 2)");
                    table.CheckConstraint("ck_match_result_players_side", "\"Side\" IN ('a','b')");
                    table.CheckConstraint("ck_match_result_players_who", "(\"UserId\" IS NOT NULL AND \"GuestName\" IS NULL AND \"ParticipantId\" IS NULL) OR (\"UserId\" IS NULL AND \"GuestName\" IS NOT NULL AND \"ParticipantId\" IS NOT NULL)");
                    table.ForeignKey(
                        name: "FK_match_result_players_match_results_ResultId",
                        column: x => x.ResultId,
                        principalTable: "match_results",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_bookings_TenantId_PlayRecomputeDueAt",
                table: "bookings",
                columns: new[] { "TenantId", "PlayRecomputeDueAt" },
                filter: "\"PlayRecomputeDueAt\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_match_result_players_ResultId_Side_Position",
                table: "match_result_players",
                columns: new[] { "ResultId", "Side", "Position" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_match_result_players_ResultId_UserId",
                table: "match_result_players",
                columns: new[] { "ResultId", "UserId" },
                unique: true,
                filter: "\"UserId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_match_result_players_TenantId_UserId",
                table: "match_result_players",
                columns: new[] { "TenantId", "UserId" });

            migrationBuilder.CreateIndex(
                name: "IX_match_results_BookingId",
                table: "match_results",
                column: "BookingId");

            migrationBuilder.CreateIndex(
                name: "IX_match_results_live_per_booking",
                table: "match_results",
                columns: new[] { "TenantId", "BookingId" },
                unique: true,
                filter: "\"Status\" IN ('pending','confirmed','disputed')");

            migrationBuilder.CreateIndex(
                name: "IX_match_results_TenantId_BookingId_CreatedAt",
                table: "match_results",
                columns: new[] { "TenantId", "BookingId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_match_results_TenantId_ConfirmDueAt",
                table: "match_results",
                columns: new[] { "TenantId", "ConfirmDueAt" },
                filter: "\"Status\" = 'pending'");

            migrationBuilder.CreateIndex(
                name: "IX_match_results_TenantId_DisputedAt",
                table: "match_results",
                columns: new[] { "TenantId", "DisputedAt" },
                filter: "\"Status\" = 'disputed'");

            migrationBuilder.CreateIndex(
                name: "IX_match_results_TenantId_RecordedByUserId_IdempotencyKey",
                table: "match_results",
                columns: new[] { "TenantId", "RecordedByUserId", "IdempotencyKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_match_results_TenantId_Status_CreatedAt",
                table: "match_results",
                columns: new[] { "TenantId", "Status", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_member_badges_TenantId_UserId_BadgeKey",
                table: "member_badges",
                columns: new[] { "TenantId", "UserId", "BadgeKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_play_profiles_TenantId_UserId",
                table: "member_play_profiles",
                columns: new[] { "TenantId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_streak_pauses_TenantId_UserId",
                table: "member_streak_pauses",
                columns: new[] { "TenantId", "UserId" },
                unique: true,
                filter: "\"EndedAt\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_play_celebrations_TenantId_UserId",
                table: "play_celebrations",
                columns: new[] { "TenantId", "UserId" },
                filter: "\"SeenAt\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_play_celebrations_TenantId_UserId_DedupeKey",
                table: "play_celebrations",
                columns: new[] { "TenantId", "UserId", "DedupeKey" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "match_result_players");

            migrationBuilder.DropTable(
                name: "member_badges");

            migrationBuilder.DropTable(
                name: "member_play_profiles");

            migrationBuilder.DropTable(
                name: "member_streak_pauses");

            migrationBuilder.DropTable(
                name: "play_celebrations");

            migrationBuilder.DropTable(
                name: "match_results");

            migrationBuilder.DropIndex(
                name: "IX_bookings_TenantId_PlayRecomputeDueAt",
                table: "bookings");

            migrationBuilder.DropColumn(
                name: "PlayRecomputeDueAt",
                table: "bookings");
        }
    }
}
