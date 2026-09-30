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

/**
 * The top-level JSON keys every anonymous object a C# method RETURNS, read from the source.
 *
 * <p>
 * <b>Why responses too (review round 2, F3-1).</b> Pinning request names left the other half
 * open: `GET /admin/schedules/{id}` answers `{ schedule, timezone }`, the page read the row's
 * fields off the top level, and the detail page said "Holds no courts yet on no days" and
 * "End undefined" over a green suite — its tests stubbed a bare row. A fixture whose keys are
 * compared with these cannot be shaped by the frontend's guess.
 * </p>
 *
 * <p>
 * Reads every `Results.Ok(new { … })`, `Results.Created(…, new { … })` and `return new { … }`
 * inside the method's body, in source order. System.Text.Json writes an anonymous type's
 * property names as declared (the API sets no naming policy on them), so `name = …` is the
 * wire key; a shorthand member (`new { occurrences, timezone }`) takes its last identifier.
 * </p>
 */
export function serverResponseKeys(relativeFile: string, method: string): string[][] {
  const source = readFileSync(resolve(BACKEND, relativeFile), "utf8");
  const body = methodBody(source, method, relativeFile);
  const shapes: string[][] = [];
  const pattern = /(?:Results\.(?:Ok|Created)\(|return\s+)/g;
  for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
    const next = anonymousObjectAfter(body, m.index + m[0].length);
    if (next) shapes.push(topLevelKeys(next));
  }
  if (shapes.length === 0) throw new Error(`no anonymous response in ${method} (${relativeFile})`);
  return shapes;
}

function methodBody(source: string, method: string, file: string): string {
  const decl = new RegExp(`static[^;{}=]*?\\b${method}\\(`).exec(source);
  if (!decl) throw new Error(`method ${method} not found in ${file}`);
  // Skip the parameter list (it may hold `[AsParameters]` and generics), then take the braces.
  let i = decl.index + decl[0].length;
  for (let depth = 1; depth > 0; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") depth--;
  }
  const open = source.indexOf("{", i);
  return source.slice(open, matching(source, open, "{", "}") + 1);
}

/** The `{ … }` of a `new { … }` that starts the expression at `from`, or null if it is not one. */
function anonymousObjectAfter(text: string, from: number): string | null {
  // Created's first argument is the location string; step over one top-level argument.
  let i = from;
  const head = /^\s*new\s*\{/.exec(text.slice(i));
  if (!head) {
    const comma = topLevelComma(text, i);
    if (comma < 0) return null;
    i = comma + 1;
  }
  const again = /^\s*new\s*\{/.exec(text.slice(i));
  if (!again) return null;
  const open = i + again[0].length - 1;
  return text.slice(open + 1, matching(text, open, "{", "}"));
}

function topLevelComma(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) { if (depth === 0) return -1; depth--; }
    if (ch === "," && depth === 0) return i;
    if (ch === ";" && depth === 0) return -1;
  }
  return -1;
}

function matching(text: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    if (text[i] === c && --depth === 0) return i;
  }
  throw new Error("unbalanced source");
}

function topLevelKeys(inner: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of inner) {
    if (ch === "\"") quoted = !quoted;
    // Angle brackets are not counted: `<=` and `=>` are far commoner in a projection than a
    // two-argument generic, and a generic's comma is the only one they would protect.
    if (!quoted && "([{".includes(ch)) depth++;
    if (!quoted && ")]}".includes(ch)) depth--;
    if (!quoted && ch === "," && depth === 0) { entries.push(current); current = ""; continue; }
    current += ch;
  }
  entries.push(current);
  return entries
    .map((e) => e.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
    .map((e) => {
      const named = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(e);
      if (named) return named[1];
      const last = /([A-Za-z_]\w*)\s*$/.exec(e);
      return last ? last[1] : e;
    });
}
