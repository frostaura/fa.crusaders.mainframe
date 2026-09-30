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

/**
 * The keys of every anonymous object a method builds right after `anchor` — the ITEMS of a list
 * the response carries (`results.Add(new { user_id, result })`), which `serverResponseKeys` cannot
 * see because it reads only what is returned. Review round 4 (A4-2): the group add answered
 * `{ results: [{ user_id, result }] }`, the screen read `{ id, status }` rows and counts the
 * server never sends, and said a success was a refusal.
 */
export function serverItemKeys(relativeFile: string, method: string, anchor: string): string[][] {
  const source = readFileSync(resolve(BACKEND, relativeFile), "utf8");
  const body = methodBody(source, method, relativeFile);
  const shapes: string[][] = [];
  for (let at = body.indexOf(anchor); at >= 0; at = body.indexOf(anchor, at + anchor.length)) {
    const next = anonymousObjectAfter(body, at + anchor.length);
    if (next) shapes.push(topLevelKeys(next));
  }
  if (shapes.length === 0) throw new Error(`no anonymous item after ${anchor} in ${method} (${relativeFile})`);
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

/**
 * The member names of a C# enum, read from the source — so a frontend list of ledger types (or
 * any other enum mirrored in copy) is compared with what the server can actually write.
 */
export function serverEnumMembers(relativeFile: string, name: string): string[] {
  const source = readFileSync(resolve(BACKEND, relativeFile), "utf8");
  const start = source.search(new RegExp(`enum\\s+${name}\\b`));
  if (start < 0) throw new Error(`enum ${name} not found in ${relativeFile}`);
  const open = source.indexOf("{", start);
  const body = source.slice(open + 1, matching(source, open, "{", "}"))
    .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return body.split(",").map((part) => part.split("=")[0].trim()).filter((part) => /^[A-Za-z_]\w*$/.test(part));
}

/* ───────────────────── response shapes beyond one static method (review round 4, A4-2) ───────────────────── */

/**
 * Where on the server a response is built: a member's name (static or instance, block- or
 * expression-bodied — `Project`, `DeviceView.Of`, `AddSeatsAsync`), or an inline route lambda
 * named by the text of its registration (`{ route: 'admin.MapGet("/{id:guid}/deliveries"' }`).
 *
 * <p>
 * <b>Why a second set of readers rather than a wider `serverResponseKeys`.</b> Round 4 found the
 * group add's reply read by a screen that had never been compared with it, and pinning EVERY admin
 * reply means reading the handlers where they actually are: half of them are inline lambdas, some
 * are instance methods on a service, some build a `Dictionary` rather than an anonymous object, and
 * the member-detail rows are records with `[JsonPropertyName]`. The existing readers keep their
 * exact behaviour; these are additive.
 * </p>
 *
 * <p>
 * <b>Keys come back as the WIRE writes them.</b> `ConfigureHttpJsonOptions` in Program.cs adds a
 * converter and sets no naming policy, so the Web defaults stand: property names (anonymous types
 * included) go through the camelCase policy, which leaves a snake_case name as written and turns a
 * shorthand `x.UserId` into `userId`; dictionary keys have no policy and are written verbatim.
 * </p>
 */
export type ServerScope = string | { route: string };

/** The source text of a scope's body — for asserting that a handler DELEGATES where a test says. */
export function serverBody(relativeFile: string, scope: ServerScope): string {
  const source = readFileSync(resolve(BACKEND, relativeFile), "utf8");
  return scopeBody(source, scope, relativeFile);
}

/**
 * The keys of every anonymous object a scope answers: `Results.Ok(new { … })`, `Results.Created(…,
 * new { … })`, `return new { … }`, or — for an expression-bodied member — the `=> new { … }` itself.
 * In source order. Throws when there is none, so a moved handler fails loudly rather than vacuously.
 */
export function serverShapes(relativeFile: string, scope: ServerScope): string[][] {
  const body = serverBody(relativeFile, scope);
  const shapes: string[][] = [];
  const expression = /^\s*new\s*\{/.exec(body);
  if (expression) shapes.push(wireKeys(body.slice(expression[0].length, matching(body, expression[0].length - 1, "{", "}"))));
  const pattern = /(?:Results\.(?:Ok|Created)\(|return\s+)/g;
  for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
    const next = anonymousObjectAfter(body, m.index + m[0].length);
    if (next) shapes.push(wireKeys(next));
  }
  if (shapes.length === 0) throw new Error(`no anonymous response in ${describeScope(scope)} (${relativeFile})`);
  return shapes;
}

/** Characters a RegExp reads as syntax. A Set, not a bracket-class regex: lizard's lexer desyncs on one. */
const REGEXP_SYNTAX = new Set(Array.from(".*+?^$" + "{}()|[]\\"));

function escapeRegExp(text: string): string {
  return Array.from(text, (ch) => (REGEXP_SYNTAX.has(ch) ? `\\${ch}` : ch)).join("");
}

/**
 * The keys of every anonymous object that starts right after `anchor` inside a scope — a nested
 * block (`/tariff = /`), a list's items (`"Select(r => "`), a conditional one (a RegExp ending in the `? null :` before it).
 * The object must follow the anchor directly (`new { … }` or `(object)new { … }`), so an anchor that
 * lands on anything else is skipped rather than borrowing the next object along.
 */
export function serverShapesAt(relativeFile: string, scope: ServerScope, anchor: string | RegExp): string[][] {
  const body = serverBody(relativeFile, scope);
  const shapes: string[][] = [];
  const pattern = typeof anchor === "string"
    ? new RegExp(escapeRegExp(anchor), "g")
    : new RegExp(anchor.source, anchor.flags.includes("g") ? anchor.flags : `${anchor.flags}g`);
  for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
    const head = /^\s*(?:\(object\)\s*)?new\s*\{/.exec(body.slice(m.index + m[0].length));
    if (!head) continue;
    const open = m.index + m[0].length + head[0].length - 1;
    shapes.push(wireKeys(body.slice(open + 1, matching(body, open, "{", "}"))));
  }
  if (shapes.length === 0) throw new Error(`no anonymous object after ${String(anchor)} in ${describeScope(scope)} (${relativeFile})`);
  return shapes;
}

/*
 * Patterns with a quote in them are built from strings: lizard's .tsx lexer reads a `"` inside a
 * regex literal as the start of a string and scores the rest of the file as one function.
 */
const QUOTE = String.fromCharCode(34);
const APOSTROPHE = String.fromCharCode(39);
const DICTIONARY_KEY = new RegExp(`^\\[${QUOTE}([^${QUOTE}]+)${QUOTE}\\]\\s*=`);
const DEFAULT_VALUE = new RegExp(`=(?!\\s*${QUOTE})`);
const PINNED_NAME = new RegExp(`JsonPropertyName\\(\\s*${QUOTE}([^${QUOTE}]+)${QUOTE}\\s*\\)`);

/**
 * The keys of a `new Dictionary<string, object?> { ["k"] = … }` a scope builds (the first one), plus
 * every `variable["k"] = …` it assigns afterwards when `variable` is named. Dictionary keys are
 * written verbatim — no naming policy touches them.
 */
export function serverDictionaryKeys(relativeFile: string, scope: ServerScope, variable?: string): string[] {
  const body = serverBody(relativeFile, scope);
  const keys: string[] = [];
  const start = /new\s+Dictionary<[^>]*>\s*(?:\(\s*\))?\s*\{/.exec(body);
  if (start) {
    const open = start.index + start[0].length - 1;
    const inner = body.slice(open + 1, matching(body, open, "{", "}"));
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      if (ch === "[" && depth === 1) {
        const key = DICTIONARY_KEY.exec(inner.slice(i));
        if (key) keys.push(key[1]);
      }
    }
  }
  if (variable) {
    const assign = new RegExp(`\\b${variable}\\["([^"]+)"\\]\\s*=(?!=)`, "g");
    for (let m = assign.exec(body); m; m = assign.exec(body)) keys.push(m[1]);
  }
  if (keys.length === 0) throw new Error(`no dictionary keys in ${describeScope(scope)} (${relativeFile})`);
  return keys;
}

/**
 * The JSON properties of a C# record or class used as a RESPONSE — positional parameters and
 * `{ get; … }` properties both, each under its `[JsonPropertyName]` when it has one and the
 * camelCase policy's spelling when it does not. `[JsonIgnore]` members are left out.
 */
export function serverTypeProperties(relativeFile: string, type: string): string[] {
  const source = withoutComments(readFileSync(resolve(BACKEND, relativeFile), "utf8"));
  const decl = new RegExp(`\\b(?:record|class|struct)\\s+${type}\\b`).exec(source);
  if (!decl) throw new Error(`type ${type} not found in ${relativeFile}`);
  const names: string[] = [];
  let i = decl.index + decl[0].length;
  while (/\s/.test(source[i])) i++;
  if (source[i] === "(") {
    const close = matching(source, i, "(", ")");
    for (const part of splitTopLevel(source.slice(i + 1, close))) {
      const name = propertyName(part.split(DEFAULT_VALUE)[0]);
      if (name) names.push(name);
    }
    i = close + 1;
  }
  const brace = source.slice(i).search(/[{;]/);
  if (brace >= 0 && source[i + brace] === "{") {
    const open = i + brace;
    const body = source.slice(open, matching(source, open, "{", "}") + 1);
    const prop = /((?:\[[^\]]*\]\s*)*)public\s+(?!static\b|const\b|sealed\b|record\b|class\b)[\w<>?,.[\]\s]+?\s+(\w+)\s*\{\s*(?:get|init)/g;
    for (let m = prop.exec(body); m; m = prop.exec(body)) {
      if (depthAt(body, m.index) !== 1) continue;
      const name = propertyName(`${m[1]} ${m[2]}`);
      if (name) names.push(name);
    }
  }
  return names;
}

function propertyName(declaration: string): string | null {
  if (/\bJsonIgnore\b/.test(declaration)) return null;
  const pinned = PINNED_NAME.exec(declaration);
  if (pinned) return pinned[1];
  const last = /([A-Za-z_]\w*)\s*$/.exec(declaration.replace(/\[[^\]]*\]/g, "").trim());
  return last ? camel(last[1]) : null;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("<([".includes(ch)) depth++;
    if (">)]".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function depthAt(text: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") depth--;
  }
  return depth;
}

/** System.Text.Json's camelCase policy, for the identifiers this codebase uses. */
function camel(name: string): string {
  if (!/^[A-Z]/.test(name)) return name;
  let upper = 0;
  while (upper < name.length && /[A-Z]/.test(name[upper])) upper++;
  if (upper === 1 || upper === name.length) return name.slice(0, upper).toLowerCase() + name.slice(upper);
  return name.slice(0, upper - 1).toLowerCase() + name.slice(upper - 1);
}

function wireKeys(inner: string): string[] {
  return topLevelKeys(inner).map(camel);
}

function describeScope(scope: ServerScope): string {
  return typeof scope === "string" ? scope : `route ${scope.route}`;
}

/**
 * The source with its comments blanked out (same length, so indices hold). The shared key reader
 * splits on commas BEFORE it drops a comment, so a comment with a comma in it — this codebase
 * explains nearly every wire key in one — would otherwise read as extra keys.
 */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === QUOTE || ch === APOSTROPHE) {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function scopeBody(raw: string, scope: ServerScope, file: string): string {
  const source = withoutComments(raw);
  return typeof scope === "string" ? memberBody(source, scope, file) : routeBody(source, scope.route, file);
}

/** A route lambda's body: its block, or an expression running to the Map call's `)` or a top-level `,` / `;`. */
function routeBody(source: string, route: string, file: string): string {
  const at = source.indexOf(route);
  if (at < 0) throw new Error(`route ${route} not found in ${file}`);
  const arrow = source.indexOf("=>", at) + 2;
  const block = /^\s*\{/.exec(source.slice(arrow));
  if (block) {
    const open = arrow + block[0].length - 1;
    return source.slice(open, matching(source, open, "{", "}") + 1);
  }
  return source.slice(arrow, expressionEnd(source, arrow, (ch, depth) => depth < 0 || ((ch === "," || ch === ";") && depth === 0)));
}

/** A named member's body: its block, or an expression body running to its `;` at depth 0. */
function memberBody(source: string, member: string, file: string): string {
  const decl = new RegExp(`(?:static|async|private|public|internal|protected)[^;{}=()]*?\\b${member}\\(`).exec(source);
  if (!decl) throw new Error(`member ${member} not found in ${file}`);
  let i = decl.index + decl[0].length;
  for (let depth = 1; depth > 0; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") depth--;
  }
  const expression = /^\s*=>/.exec(source.slice(i));
  if (expression) {
    const from = i + expression[0].length;
    return source.slice(from, expressionEnd(source, from, (ch, depth) => ch === ";" && depth === 0));
  }
  const open = source.indexOf("{", i);
  return source.slice(open, matching(source, open, "{", "}") + 1);
}

/** The index where `stop` first holds, tracking bracket depth from `from`. */
function expressionEnd(source: string, from: number, stop: (ch: string, depth: number) => boolean): number {
  let depth = 0;
  let end = from;
  for (; end < source.length; end++) {
    const ch = source[end];
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (stop(ch, depth)) break;
  }
  return end;
}
