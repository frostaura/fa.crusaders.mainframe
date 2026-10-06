using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Puts realistic rows into EVERY table of whatever schema a database is at, by reading that
/// schema from the catalogue — no per-migration seed SQL, so a new migration's tables are filled
/// the moment they exist. Used by <see cref="MigrationUpgradePathTests"/>.
///
/// <para>
/// <b>One round = two clubs.</b> Each round inserts two complete row graphs, each under its own
/// tenant: a <i>rich</i> one (every nullable column populated, booleans true, numbers 1) and a
/// <i>sparse</i> one (every nullable column NULL, booleans false, numbers 0). Inside a graph the rows
/// point at each other the way the app's do: every <c>TenantId</c> is the graph's tenant, and a uuid
/// column named <c>…UserId</c>, <c>…BookingId</c>, <c>GroupId</c> or <c>ScheduleId</c> holds the id of
/// the graph's row in <c>users</c>, <c>bookings</c>, <c>member_groups</c> or <c>booking_schedules</c>
/// (the table whose name ends in the column's last word, pluralised). That matters because a data
/// migration joins on those columns (<c>GroupsReplaceClass</c> walks tenants → settings → memberships):
/// rows with unrelated random ids would never reach its interesting branches.
/// </para>
///
/// <para>
/// <b>Constraints are honoured generically.</b> Real foreign keys fix the insert order. CHECK
/// constraints are satisfied by search: each constrained column gets a short candidate list — its
/// preferred value, NULL, 0, 1, 2 and every literal its constraints mention (±1) — and Postgres itself
/// evaluates the constraint expressions over the cross product and returns the most-preferred
/// combination that passes. Unique values (slugs, keys, hashes) carry a per-filler sequence number.
/// A table the filler cannot satisfy fails loudly naming the table and the constraint; it is never
/// skipped, so "every table is populated" is a property of the test, not a hope.
/// </para>
/// </summary>
internal sealed class PopulatedSchemaFiller
{
    // Text is shaped by column name where the app's values have a shape a migration may rely on
    // (an email, a MAC, a JSON document); everything else is "<sequence> <column>", unique and short.
    private static readonly DateTimeOffset BaseTime = new(2026, 9, 15, 8, 0, 0, TimeSpan.Zero);

    private int _sequence;
    private int _round;

    private enum Variant { Rich, Sparse }

    private sealed record Column(string Name, string DataType, string UdtName, string SqlType, bool Nullable, int? MaxLength, string? Default);

    private sealed record Check(string Name, string Expression, IReadOnlyList<string> Columns);

    private sealed record Table(string Name, IReadOnlyList<Column> Columns, IReadOnlyList<Check> Checks, IReadOnlyDictionary<string, string> ForeignKeys);

    /// <summary>One rich and one sparse row in every table that exists now.</summary>
    public async Task FillAsync(string connectionString)
    {
        _round++;
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        var tables = await ReadSchemaAsync(conn);

        foreach (var variant in new[] { Variant.Rich, Variant.Sparse })
        {
            // Every row's id is decided up front, so a column can point at a table filled later.
            var ids = tables.Where(t => t.Columns.Any(c => c.Name == "Id" && c.DataType == "uuid"))
                .ToDictionary(t => t.Name, _ => Guid.NewGuid());
            foreach (var table in InsertOrder(tables))
            {
                await InsertRowAsync(conn, table, variant, ids, tables);
            }
        }
    }

    // ---- the schema, as the catalogue has it now --------------------------------------------

    private static async Task<IReadOnlyList<Table>> ReadSchemaAsync(NpgsqlConnection conn)
    {
        var columns = new Dictionary<string, List<Column>>();
        await using (var cmd = new NpgsqlCommand("""
            SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
                   format_type(a.atttypid, a.atttypmod), c.is_nullable = 'YES', c.character_maximum_length, c.column_default
              FROM information_schema.columns c
              JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
              JOIN pg_attribute a ON a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass AND a.attname = c.column_name
             WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name NOT LIKE '\_\_EF%'
               AND c.is_generated = 'NEVER' AND c.is_identity = 'NO' AND coalesce(c.column_default, '') NOT LIKE 'nextval(%'
             ORDER BY c.table_name, c.ordinal_position
            """, conn))
        await using (var r = await cmd.ExecuteReaderAsync())
        {
            while (await r.ReadAsync())
            {
                var table = r.GetString(0);
                if (!columns.TryGetValue(table, out var list))
                {
                    columns[table] = list = [];
                }
                list.Add(new Column(r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetBoolean(5),
                    r.IsDBNull(6) ? null : r.GetInt32(6), r.IsDBNull(7) ? null : r.GetString(7)));
            }
        }

        var checks = new Dictionary<string, List<Check>>();
        var foreignKeys = new Dictionary<string, Dictionary<string, string>>();
        await using (var cmd = new NpgsqlCommand("""
            SELECT k.conrelid::regclass::text, k.contype::text, k.conname, pg_get_constraintdef(k.oid),
                   array(SELECT a.attname::text FROM unnest(k.conkey) n JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = n),
                   coalesce(k.confrelid::regclass::text, '')
              FROM pg_constraint k
             WHERE k.connamespace = 'public'::regnamespace AND k.contype IN ('c', 'f')
            """, conn))
        await using (var r = await cmd.ExecuteReaderAsync())
        {
            while (await r.ReadAsync())
            {
                var table = r.GetString(0).Trim('"');
                var cols = r.GetFieldValue<string[]>(4);
                if (r.GetString(1) == "c")
                {
                    if (!checks.TryGetValue(table, out var list))
                    {
                        checks[table] = list = [];
                    }
                    list.Add(new Check(r.GetString(2), CheckExpression(r.GetString(3)), cols));
                }
                else
                {
                    if (!foreignKeys.TryGetValue(table, out var map))
                    {
                        foreignKeys[table] = map = [];
                    }
                    map[cols[0]] = r.GetString(5).Trim('"');
                }
            }
        }

        return [.. columns.Select(kv => new Table(kv.Key, kv.Value,
            checks.GetValueOrDefault(kv.Key) ?? [],
            (IReadOnlyDictionary<string, string>?)foreignKeys.GetValueOrDefault(kv.Key) ?? new Dictionary<string, string>()))];
    }

    private static string CheckExpression(string definition)
    {
        var body = definition.StartsWith("CHECK ", StringComparison.Ordinal) ? definition[6..] : definition;
        return body.EndsWith(" NOT VALID", StringComparison.Ordinal) ? body[..^10] : body;
    }

    /// <summary>Referenced tables first, by real foreign keys only; inferred references need no order.</summary>
    private static IEnumerable<Table> InsertOrder(IReadOnlyList<Table> tables)
    {
        var byName = tables.ToDictionary(t => t.Name);
        var done = new HashSet<string>();
        var order = new List<Table>();
        void Visit(Table t, HashSet<string> path)
        {
            if (done.Contains(t.Name) || !path.Add(t.Name))
            {
                return;
            }
            foreach (var target in t.ForeignKeys.Values)
            {
                if (target != t.Name && byName.TryGetValue(target, out var dep))
                {
                    Visit(dep, path);
                }
            }
            done.Add(t.Name);
            order.Add(t);
        }
        foreach (var t in tables.OrderBy(t => t.Name, StringComparer.Ordinal))
        {
            Visit(t, []);
        }
        return order;
    }

    // ---- one row ------------------------------------------------------------------------------

    private async Task InsertRowAsync(NpgsqlConnection conn, Table table, Variant variant,
        IReadOnlyDictionary<string, Guid> ids, IReadOnlyList<Table> tables)
    {
        var candidates = table.Columns.ToDictionary(c => c.Name, c => Candidates(table, c, variant, ids, tables));
        var chosen = table.Columns.ToDictionary(c => c.Name, c => candidates[c.Name][0]);
        await SatisfyChecksAsync(conn, table, candidates, chosen);

        var sql = $"INSERT INTO \"{table.Name}\" ({string.Join(", ", table.Columns.Select(c => $"\"{c.Name}\""))}) " +
                  $"VALUES ({string.Join(", ", table.Columns.Select(c => chosen[c.Name]))})";
        try
        {
            await using var cmd = new NpgsqlCommand(sql, conn);
            await cmd.ExecuteNonQueryAsync();
        }
        catch (PostgresException e)
        {
            throw new InvalidOperationException(
                $"The populated-schema filler could not insert a {variant} row into {table.Name} " +
                $"({e.SqlState} {e.ConstraintName}: {e.MessageText}). Teach the filler the shape this table needs — " +
                $"never skip the table.\n{sql}", e);
        }
    }

    /// <summary>
    /// Columns that share a CHECK form a group; each group's candidates are cross-joined and Postgres
    /// returns the most-preferred combination for which every constraint is not false.
    /// </summary>
    private static async Task SatisfyChecksAsync(NpgsqlConnection conn, Table table,
        Dictionary<string, List<string>> candidates, Dictionary<string, string> chosen)
    {
        var known = table.Columns.Select(c => c.Name).ToHashSet();
        var checks = table.Checks.Where(k => k.Columns.All(known.Contains)).ToList();
        foreach (var group in Groups(checks))
        {
            var cols = group.SelectMany(k => k.Columns).Distinct().ToList();
            var width = 8;
            while (cols.Aggregate(1L, (n, c) => n * Math.Min(width, candidates[c].Count)) > 20_000 && width > 2)
            {
                width--;
            }
            var from = string.Join(" CROSS JOIN ", cols.Select((c, i) =>
                $"(VALUES {string.Join(", ", candidates[c].Take(width).Select((v, o) => $"({o}, {v})"))}) AS c{i}(o{i}, \"{c}\")"));
            var where = string.Join(" AND ", group.Select(k => $"({k.Expression}) IS NOT FALSE"));
            var sql = $"SELECT {string.Join(", ", cols.Select((_, i) => $"o{i}"))} FROM {from} WHERE {where} " +
                      $"ORDER BY {string.Join(" + ", cols.Select((_, i) => $"o{i}"))} LIMIT 1";

            await using var cmd = new NpgsqlCommand(sql, conn);
            await using var r = await cmd.ExecuteReaderAsync();
            if (!await r.ReadAsync())
            {
                throw new InvalidOperationException(
                    $"The populated-schema filler found no values for {table.Name} that pass " +
                    $"{string.Join(", ", group.Select(k => k.Name))}. Widen its candidates for " +
                    $"{string.Join(", ", cols)} — never skip the table.\n{sql}");
            }
            for (var i = 0; i < cols.Count; i++)
            {
                chosen[cols[i]] = candidates[cols[i]][r.GetInt32(i)];
            }
        }
    }

    private static IEnumerable<List<Check>> Groups(List<Check> checks)
    {
        var remaining = checks.ToList();
        while (remaining.Count > 0)
        {
            var group = new List<Check> { remaining[0] };
            remaining.RemoveAt(0);
            var cols = group[0].Columns.ToHashSet();
            bool grew;
            do
            {
                var joining = remaining.Where(k => k.Columns.Any(cols.Contains)).ToList();
                grew = joining.Count > 0;
                foreach (var k in joining)
                {
                    remaining.Remove(k);
                    group.Add(k);
                    cols.UnionWith(k.Columns);
                }
            } while (grew);
            yield return group;
        }
    }

    // ---- values -------------------------------------------------------------------------------

    /// <summary>The column's SQL literals, most preferred first; [0] is used when no CHECK names it.</summary>
    private List<string> Candidates(Table table, Column c, Variant variant,
        IReadOnlyDictionary<string, Guid> ids, IReadOnlyList<Table> tables)
    {
        var list = new List<string>();
        var nullFirst = variant == Variant.Sparse && c.Nullable;
        if (nullFirst)
        {
            list.Add("NULL");
        }
        list.AddRange(Preferred(table, c, variant, ids, tables));
        list.AddRange(Alternatives(table, c));
        if (c.Nullable && !nullFirst)
        {
            list.Add("NULL");
        }
        return [.. list.Distinct()];
    }

    private IEnumerable<string> Preferred(Table table, Column c, Variant variant,
        IReadOnlyDictionary<string, Guid> ids, IReadOnlyList<Table> tables)
    {
        var rich = variant == Variant.Rich;
        switch (c.DataType)
        {
            case "uuid":
                yield return Literal(Reference(table, c, ids, tables).ToString(), c);
                break;
            case "integer" or "smallint" or "bigint" or "numeric" or "real" or "double precision":
                yield return Literal(rich ? "1" : "0", c);
                break;
            case "boolean":
                yield return rich ? "true" : "false";
                break;
            case "timestamp with time zone" or "timestamp without time zone":
                yield return Literal(Time(c.Name).ToString("O", CultureInfo.InvariantCulture), c);
                break;
            case "date":
                yield return Literal(DateOnly.FromDateTime(Time(c.Name).UtcDateTime).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), c);
                break;
            case "jsonb" or "json":
                yield return c.Default is { } d && d.Contains("::json", StringComparison.Ordinal) ? d : Literal("{}", c);
                break;
            case "bytea":
                yield return $"'\\x{Convert.ToHexString(Guid.NewGuid().ToByteArray())}'::bytea";
                break;
            case "ARRAY":
                yield return Literal(!rich ? "{}" : c.UdtName == "_text" || c.UdtName == "_varchar" ? $"{{{Next()}}}" : "{1}", c);
                break;
            case "text" or "character varying" or "character":
                yield return Literal(Text(c), c);
                break;
            default:
                throw new InvalidOperationException(
                    $"The populated-schema filler has no value for {table.Name}.{c.Name} of type {c.SqlType}. Teach it one.");
        }
    }

    /// <summary>What a CHECK search may try instead of the preferred value.</summary>
    private IEnumerable<string> Alternatives(Table table, Column c)
    {
        var literals = table.Checks.Where(k => k.Columns.Contains(c.Name)).SelectMany(k => Literals(k.Expression)).ToList();
        switch (c.DataType)
        {
            case "integer" or "smallint" or "bigint" or "numeric" or "real" or "double precision":
                foreach (var v in new[] { "1", "0", "2" }.Concat(literals.Where(IsNumber).SelectMany(Around)))
                {
                    yield return Literal(v, c);
                }
                break;
            case "boolean":
                yield return "true";
                yield return "false";
                break;
            case "uuid":
                yield return Literal(Guid.NewGuid().ToString(), c);
                break;
            case "timestamp with time zone" or "timestamp without time zone":
                yield return Literal(Time(c.Name).AddHours(-2).ToString("O", CultureInfo.InvariantCulture), c);
                yield return Literal(Time(c.Name).AddHours(2).ToString("O", CultureInfo.InvariantCulture), c);
                break;
            case "text" or "character varying" or "character":
                foreach (var v in literals.Where(l => !IsNumber(l)))
                {
                    yield return Literal(v, c);
                }
                break;
            default:
                break;
        }
    }

    private static IEnumerable<string> Around(string number)
    {
        var n = decimal.Parse(number, CultureInfo.InvariantCulture);
        return [number, (n + 1).ToString(CultureInfo.InvariantCulture), (n - 1).ToString(CultureInfo.InvariantCulture)];
    }

    private static bool IsNumber(string s) => decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out _);

    /// <summary>The string and number literals of a constraint expression: <c>'a'::bpchar</c> gives <c>a</c>, <c>(0)::numeric</c> gives <c>0</c>.</summary>
    private static IEnumerable<string> Literals(string expression)
    {
        foreach (Match m in Regex.Matches(expression, @"'((?:[^']|'')*)'"))
        {
            yield return m.Groups[1].Value.Replace("''", "'", StringComparison.Ordinal);
        }
        var withoutStrings = Regex.Replace(expression, @"'(?:[^']|'')*'", "''");
        foreach (Match m in Regex.Matches(withoutStrings, @"(?<![\w""])-?\d+(?:\.\d+)?(?![\w""])"))
        {
            yield return m.Value;
        }
    }

    /// <summary>
    /// <c>Id</c> is this row's own id; <c>TenantId</c>, <c>ActorUserId</c>, <c>ScheduleId</c>… point at
    /// the graph's row in the table their last word names (<c>users</c>, <c>booking_schedules</c>); a
    /// real foreign key points where it says; anything else is a fresh id.
    /// </summary>
    private static Guid Reference(Table table, Column c, IReadOnlyDictionary<string, Guid> ids, IReadOnlyList<Table> tables)
    {
        if (c.Name == "Id" && ids.TryGetValue(table.Name, out var own))
        {
            return own;
        }
        if (table.ForeignKeys.TryGetValue(c.Name, out var target) && ids.TryGetValue(target, out var fk))
        {
            return fk;
        }
        if (c.Name.EndsWith("Id", StringComparison.Ordinal) && c.Name.Length > 2)
        {
            var words = Regex.Matches(c.Name[..^2], "[A-Z][a-z0-9]*").Select(m => m.Value.ToLowerInvariant()).ToList();
            for (var take = words.Count; take >= 1; take--)
            {
                var plural = string.Join("_", words.Skip(words.Count - take)) + "s";
                var match = tables.Select(t => t.Name).Where(n => n == plural || n.EndsWith("_" + plural, StringComparison.Ordinal))
                    .OrderBy(n => n == plural ? 0 : 1).ThenBy(n => n, StringComparer.Ordinal).FirstOrDefault();
                if (match is not null && ids.TryGetValue(match, out var inferred))
                {
                    return inferred;
                }
            }
        }
        return Guid.NewGuid();
    }

    /// <summary>The round's moment; an end, expiry or deadline sits an hour after it.</summary>
    private DateTimeOffset Time(string column)
    {
        var at = BaseTime.AddDays(_round);
        return Regex.IsMatch(column, "End|Expires|Until|Deadline") ? at.AddHours(1) : at;
    }

    private string Text(Column c)
    {
        var value = c.Name switch
        {
            var n when n.Contains("Email", StringComparison.Ordinal) => $"member{Next()}@club.test",
            // What the app stores: twelve lower-case hex digits, no separators.
            var n when n.Contains("MacAddress", StringComparison.Ordinal) => int.Parse(Next(), CultureInfo.InvariantCulture).ToString("x12", CultureInfo.InvariantCulture),
            var n when n.EndsWith("Json", StringComparison.Ordinal) => "{}",
            _ => $"{Next()} {c.Name}",
        };
        return c.MaxLength is { } max && value.Length > max ? value[..max] : value;
    }

    private string Next() => (++_sequence).ToString(CultureInfo.InvariantCulture);

    private static string Literal(string value, Column c)
    {
        var escaped = new StringBuilder(value).Replace("'", "''");
        return $"'{escaped}'::{c.SqlType}";
    }
}
