using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// Makes <c>admin_change_log</c> append-only at the database, not merely by convention.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A loud trigger, not a silent rule.</b> <c>CREATE RULE … DO INSTEAD NOTHING</c> was
    /// rejected: a rule makes a <c>DELETE</c> report zero rows and <i>succeed</i>, so an
    /// operator believes they deleted something and the application believes it worked. A write
    /// that must not happen has to fail where somebody can see it, which is why the function
    /// raises with <c>ERRCODE 42501</c> (insufficient privilege) and names the operation it
    /// refused.
    /// </para>
    ///
    /// <para>
    /// <b>Two triggers, because Postgres requires it.</b> A <c>TRUNCATE</c> trigger must be
    /// statement-level; <c>DELETE</c> and <c>UPDATE</c> are row-level here so the exception
    /// names the operation that was attempted. One trigger cannot cover all three.
    /// </para>
    ///
    /// <para>
    /// <b>The honest residual.</b> This is layer two of four — the others being no delete path
    /// in the code (pinned by <c>AdminChangeLogPostureTests</c>), the retention worker never
    /// naming the table (pinned by the same file), and the optional runtime-role
    /// <c>REVOKE</c> that only means anything once the deployment connects as a role that is
    /// not the table owner. Today the application runs its own migrations and therefore
    /// almost certainly IS the owner, and an owner can <c>ALTER TABLE … DISABLE TRIGGER</c>.
    /// So the claim this supports is <i>"no role in the application can delete these rows, and
    /// no admin has a way to"</i> — not "tamper-proof". The club would rely on the stronger
    /// sentence, which is why it is not written anywhere.
    /// </para>
    /// </remarks>
    public partial class ProtectAdminChangeLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                CREATE OR REPLACE FUNCTION admin_change_log_immutable() RETURNS trigger AS $$
                BEGIN
                  RAISE EXCEPTION 'admin_change_log is append-only (attempted %)', TG_OP
                    USING ERRCODE = '42501';
                END $$ LANGUAGE plpgsql;
                """);

            migrationBuilder.Sql("""
                CREATE TRIGGER admin_change_log_no_delete_update
                  BEFORE DELETE OR UPDATE ON admin_change_log
                  FOR EACH ROW EXECUTE FUNCTION admin_change_log_immutable();
                """);

            migrationBuilder.Sql("""
                CREATE TRIGGER admin_change_log_no_truncate
                  BEFORE TRUNCATE ON admin_change_log
                  FOR EACH STATEMENT EXECUTE FUNCTION admin_change_log_immutable();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS admin_change_log_no_truncate ON admin_change_log;");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS admin_change_log_no_delete_update ON admin_change_log;");
            migrationBuilder.Sql("DROP FUNCTION IF EXISTS admin_change_log_immutable();");
        }
    }
}
