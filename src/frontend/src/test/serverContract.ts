import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The JSON field names a backend request record binds, read from the C# source itself.
 *
 * <p>
 * <b>Why read the server's source rather than restate its names here.</b> Review round 1 found
 * repeating bookings could not be created at all: the screen sent `courtIds`, the server's
 * `ScheduleRequest` binds `courts`, and both sides had green suites because each side's tests
 * stubbed the other with its own spelling. A list of names copied into this file would drift
 * exactly as the type did. Minimal APIs bind a positional record's parameters by camelCased
 * name, so the record's parameter list IS the wire contract — this reads it.
 * </p>
 */
const BACKEND = resolve(__dirname, "..", "..", "..", "backend", "Crusaders.Mainframe.Api");

export function serverRecordFields(relativeFile: string, record: string): string[] {
  const source = readFileSync(resolve(BACKEND, relativeFile), "utf8");
  const start = source.indexOf(`record ${record}(`);
  if (start < 0) throw new Error(`record ${record} not found in ${relativeFile}`);
  const open = source.indexOf("(", start);
  let depth = 0;
  let close = open;
  for (; close < source.length; close++) {
    if (source[close] === "(") depth++;
    if (source[close] === ")" && --depth === 0) break;
  }
  const params = source.slice(open + 1, close);
  // Split on top-level commas only: `IReadOnlyList<Guid>?` carries no comma, but a generic with
  // two arguments would, and the depth count keeps it whole.
  const parts: string[] = [];
  let angle = 0;
  let current = "";
  for (const ch of params) {
    if (ch === "<") angle++;
    if (ch === ">") angle--;
    if (ch === "," && angle === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts
    .map((p) => p.split("=")[0].trim().split(/\s+/).pop() ?? "")
    .filter(Boolean)
    .map((name) => name[0].toLowerCase() + name.slice(1));
}
