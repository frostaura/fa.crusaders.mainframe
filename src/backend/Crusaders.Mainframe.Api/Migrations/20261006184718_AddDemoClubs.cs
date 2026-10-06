using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDemoClubs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "DemoSourceEpoch",
                table: "users",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "DemoSourceUserId",
                table: "users",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "DemoGeneratedAt",
                table: "tenants",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "DemoOfTenantId",
                table: "tenants",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_users_TenantId_DemoSourceUserId",
                table: "users",
                columns: new[] { "TenantId", "DemoSourceUserId" },
                unique: true,
                filter: "\"DemoSourceUserId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_tenants_DemoOfTenantId",
                table: "tenants",
                column: "DemoOfTenantId",
                unique: true,
                filter: "\"DemoOfTenantId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_users_TenantId_DemoSourceUserId",
                table: "users");

            migrationBuilder.DropIndex(
                name: "IX_tenants_DemoOfTenantId",
                table: "tenants");

            migrationBuilder.DropColumn(
                name: "DemoSourceEpoch",
                table: "users");

            migrationBuilder.DropColumn(
                name: "DemoSourceUserId",
                table: "users");

            migrationBuilder.DropColumn(
                name: "DemoGeneratedAt",
                table: "tenants");

            migrationBuilder.DropColumn(
                name: "DemoOfTenantId",
                table: "tenants");
        }
    }
}
