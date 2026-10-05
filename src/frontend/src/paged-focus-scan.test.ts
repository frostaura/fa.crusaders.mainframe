import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R14 X14-1 — every paging control hands focus on through `usePagedFocus`, as a source scan.
 *
 * <p>
 * The last page of a "Show more" / "Show older" / "Load more" list takes its control away with it,
 * and focus falls to `<body>`: the next Tab starts at the skip link and a screen reader says
 * nothing. Fixed list by list four rounds running (R8 X8-4, R9 X9-2, R12 X12-2, R13 X13-1), and the
 * wallet's "Show older" still had it in R14. So the class is closed here.
 * </p>
 *
 * <p>
 * <b>What counts as a paging control:</b> any interactive JSX element — a `<Button>`, `<button>`,
 * `<Link>`, `<a>`, `<TextLink>` or any wrapper component that takes an `onClick`, `onSelect`,
 * `href` or `to` — whose children or attributes carry a paging label: a literal, or a constant /
 * copy key (anywhere in `src`) whose value is one.
 * </p>
 *
 * <p>
 * <b>What passes:</b> its `onClick` is an identifier bound in the same file by
 * `const x = usePagedFocus(…)`, or a PROP that every call site of the enclosing component (in any
 * file) passes such an identifier, resolved the same way, a few levels deep. An inline arrow, a
 * method on some object, a link, or an unresolved prop fails — unless the file is on the allow-list,
 * whose every entry names the behavioural test that proves its own focus rule.
 * </p>
 */
const ALLOWED: Readonly<Record<string, { why: string; test: string; proves: RegExp }>> = {
  "pages/AdminLedger.tsx": {
    why: "appends with flushSync, then focuses the first FRESH id's details button in the table's own sort order; usePagedFocus counts rows and cannot follow a sort",
    test: "pages/AdminLedger.test.tsx", proves: /hands focus to the first row the last page brought, never to <body>/,
  },
  "pages/AdminDoorsLog.tsx": {
    why: "focuses the first appended row AFTER the log's sort (C4), held in state — the same sort reason",
    test: "pages/AdminDoorsLog.test.tsx", proves: /never drops focus to the body when the last page exhausts the range/,
  },
  "components/members/MemberPicker.tsx": {
    why: "its onMore is AdminMembers' client-side reveal (flushSync, no fetch for the hook to wait on), which focuses the first revealed picker row",
    test: "pages/pagedFocusAllowedR14.test.tsx", proves: /members: the last Show more focuses the first member it revealed/,
  },
  "pages/AdminMembers.tsx": {
    why: "the same client-side reveal as MemberPicker, on the members table",
    test: "pages/pagedFocusAllowedR14.test.tsx", proves: /members: the last Show more focuses the first member it revealed/,
  },
  "components/bookings/RecentGames.tsx": {
    why: "a disclosure, not a pager: \"Show N more\" becomes \"Show fewer\" in place (aria-expanded), so the focused button never unmounts",
    test: "pages/pagedFocusAllowedR14.test.tsx", proves: /"recent games"[\s\S]*Show more keeps focus on the same button/,
  },
  "components/bookings/UpcomingGames.tsx": {
    why: "the same disclosure as RecentGames",
    test: "pages/pagedFocusAllowedR14.test.tsx", proves: /"upcoming games"[\s\S]*Show more keeps focus on the same button/,
  },
};

const SRC = __dirname;
/** A label that pages: "Show more", "Show older (3 more)", "Load older scans", "Show 25 more", "See more", "Next page", … */
const PAGING = /\b(?:Show|Load|See|View)\s+(?:all\s+)?(?:\$\{[^}]*\}\s+)?(?:more|older|earlier|previous|next)\b|\b(?:Next|Previous|Older|Newer)\s+page\b|\bLoad\s+next\b/i;
const INTERACTIVE = /\b(?:onClick|onSelect|href|to)=/;

function files(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "test" ? [] : files(full, keep);
    return keep(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Code without comments. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Paging labels by where they live: `OBJECT.key` (a copy table) and bare constants or functions. */
type Keys = { objects: Map<string, Set<string>>; constants: Set<string> };

const VALUE = /(?:^|[\s,{])(\w+)\s*(?::|=)\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*)?(["`])([^"`\n]*)\2/gm;

/** Every copy table's paging keys, and every top-level constant whose value is a paging label, anywhere in src. */
function pagingKeys(sources: ReadonlyMap<string, string>): Keys {
  const keys: Keys = { objects: new Map(), constants: new Set() };
  for (const code of sources.values()) {
    for (const m of code.matchAll(/^export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*\{/gm)) {
      const body = braced(code, code.indexOf("{", m.index! + m[0].length - 1));
      for (const v of body.matchAll(VALUE)) if (PAGING.test(v[3])) {
        if (!keys.objects.has(m[1])) keys.objects.set(m[1], new Set());
        keys.objects.get(m[1])!.add(v[1]);
      }
    }
    for (const m of code.matchAll(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*)?(["`])([^"`\n]*)\2/gm)) {
      if (PAGING.test(m[3])) keys.constants.add(m[1]);
    }
  }
  return keys;
}

/** `local name → exported name` for a file's named imports (`A as B` gives B → A). */
function importsOf(code: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const [from, as] = part.replace(/\btype\s+/, "").trim().split(/\s+as\s+/);
      if (from) names.set((as ?? from).trim(), from.trim());
    }
  }
  return names;
}

/** Whether `said` (a control's attributes and children) names a paging label through a copy table or constant. */
function namesPagingKey(said: string, code: string, keys: Keys): boolean {
  const imports = importsOf(code);
  const real = (name: string) => imports.get(name) ?? name;
  const viaTable = [...said.matchAll(/\b(\w+)\.(\w+)\b/g)].some((m) => keys.objects.get(real(m[1]))?.has(m[2]));
  const viaConstant = [...said.matchAll(/\{\s*(\w+)\s*(?:\(|\})/g)].some((m) => keys.constants.has(real(m[1])));
  return viaTable || viaConstant;
}

/** The text between `from` (an opening brace) and its matching close. */
function braced(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(from + 1, i);
  }
  return code.slice(from + 1);
}

/** Where the JSX tag opening at `start` ends: the first `>` outside braces. */
function tagEnd(code: string, start: number): number {
  let depth = 0;
  for (let end = start; end < code.length; end++) {
    if (code[end] === "{") depth++;
    else if (code[end] === "}") depth--;
    else if (code[end] === ">" && depth === 0) return end;
  }
  return code.length;
}

/** An attribute's `{…}` expression on a tag, trimmed; null when absent. */
function attr(tag: string, name: string): string | null {
  const at = tag.search(new RegExp(`\\b${name}=\\{`));
  return at < 0 ? null : braced(tag, tag.indexOf("{", at)).trim();
}

/** The component (or function) the code at `index` sits in: the last top-level declaration before it. */
function enclosing(code: string, index: number): string | null {
  const head = code.slice(0, index);
  const found = [...head.matchAll(/^(?:export\s+(?:default\s+)?)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm)].at(-1);
  return found ? (found[1] ?? found[2]) : null;
}

type Control = { file: string; tag: string; label: string; onClick: string | null; at: number };

function pagingControls(file: string, code: string, keys: Keys): Control[] {
  const found: Control[] = [];
  for (const open of code.matchAll(/<([A-Za-z][\w.]*)\b/g)) {
    const end = tagEnd(code, open.index!);
    const tag = code.slice(open.index!, end);
    if (!INTERACTIVE.test(tag)) continue;
    const close = code[end - 1] === "/" ? end : code.indexOf(`</${open[1]}>`, end);
    const children = close <= end ? "" : code.slice(end + 1, close);
    // The tag's own attributes (aria-label, label) and its children, but not a handler's body.
    const said = tag.replace(/\bon\w+=\{/g, "") + children;
    if (/<[A-Za-z][\w.]*\b[^>]*\b(?:onClick|href|to)=/.test(children)) continue; // an inner control is the control
    const viaKey = namesPagingKey(said, code, keys);
    const literal = PAGING.test(said.replace(/\{[^}]*\}/g, " ")) || [...said.matchAll(/["`]([^"`]*)["`]/g)].some((m) => PAGING.test(m[1]));
    if (!viaKey && !literal) continue;
    found.push({ file, tag: open[1], label: children.trim().slice(0, 60) || tag.slice(0, 60), onClick: attr(tag, "onClick") ?? attr(tag, "onSelect"), at: open.index! });
  }
  return found;
}

/** Whether `expr`, inside component `owner` of `file`, is a usePagedFocus handler — following props to their call sites. */
function resolves(expr: string | null, file: string, owner: string | null, sources: ReadonlyMap<string, string>, depth = 0): boolean {
  if (expr === null || !/^\w+$/.test(expr) || depth > 3) return false;
  const code = sources.get(file)!;
  if (new RegExp(`\\bconst\\s+${expr}\\s*=\\s*usePagedFocus\\(`).test(code)) return true;
  if (owner === null) return false;
  // A prop: every place that renders `owner` must hand it a hook handler.
  const sites: { file: string; expr: string | null; owner: string | null }[] = [];
  for (const [other, text] of sources) {
    for (const m of text.matchAll(new RegExp(`<${owner}\\b`, "g"))) {
      const tag = text.slice(m.index!, tagEnd(text, m.index!));
      sites.push({ file: other, expr: attr(tag, expr), owner: enclosing(text, m.index!) });
    }
  }
  return sites.length > 0 && sites.every((s) => resolves(s.expr, s.file, s.owner, sources, depth + 1));
}

function scan(sources: ReadonlyMap<string, string>) {
  const keys = pagingKeys(sources);
  const controls = [...sources].flatMap(([file, code]) => (file.endsWith(".tsx") ? pagingControls(file, code, keys) : []));
  const offenders = controls
    .filter((c) => !(c.file in ALLOWED))
    .filter((c) => !resolves(c.onClick, c.file, enclosing(sources.get(c.file)!, c.at), sources))
    .map((c) => `${c.file}: <${c.tag} onClick={${c.onClick ?? "∅"}}>${c.label}`);
  return { keys, controls, offenders };
}

function sourcesNow(): Map<string, string> {
  return new Map(files(SRC, (n) => /\.tsx?$/.test(n)).map((full) => [relative(SRC, full).split(sep).join("/"), codeOf(full)]));
}

describe("paging controls hand focus on (R14 X14-1)", () => {
  const sources = sourcesNow();
  const { keys, controls, offenders } = scan(sources);

  it("finds the paging labels and controls it guards (a scan that matches nothing proves nothing)", () => {
    expect(keys.constants).toContain("showOlderLabel");
    expect(keys.constants).toContain("HISTORY_SHOW_MORE");
    expect(keys.objects.get("NIGHT_TAB_COPY")).toContain("showMore");
    expect(keys.objects.get("MEMBERS_PAGE")).toContain("showMore");
    expect(keys.objects.get("WALLET_MINI_COPY")).toBeUndefined(); // "See activity" is a link, not a pager
    const where = new Set(controls.map((c) => c.file));
    for (const file of ["pages/Wallet.tsx", "components/inbox/InboxList.tsx", "pages/ProfileResults.tsx", "pages/monitoring/MemberNight.tsx", "pages/AdminLedger.tsx"]) {
      expect(where).toContain(file);
    }
  });

  it("every paging control takes a usePagedFocus handler, or is allow-listed with its reason and its test", () => {
    expect(offenders).toEqual([]);
  });

  it("each allow-list entry still has a paging control, and names a test that exists and says what it proves", () => {
    const where = new Set(controls.map((c) => c.file));
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect(where, file).toContain(file);
      expect(existsSync(join(SRC, entry.test)), entry.test).toBe(true);
      expect(readFileSync(join(SRC, entry.test), "utf8"), `${entry.test} for ${file}`).toMatch(entry.proves);
    }
  });

  /** The regressions this scan exists for, applied to today's source in memory: each must go red. */
  it.each([
    ["the wallet's handler inlined at the call site", "pages/Wallet.tsx", "onOlder={showOlder}", "onOlder={() => void load(shown + PAGE_SIZE)}"],
    ["the wallet's handler bypassing the hook, the hook call left in the file", "pages/Wallet.tsx", "onClick={onOlder}", "onClick={() => onOlder()}"],
    ["the Night's More button handed the raw loader", "pages/monitoring/MemberNight.tsx", "onMore={showMore}", "onMore={night.loadMore}"],
    ["the inbox's Show more on a plain fetch", "components/inbox/InboxList.tsx", "onClick={showMore}", "onClick={feed.more.run}"],
    ["a See more link added beside a list", "pages/Wallet.tsx", "{showOlderLabel(total - shown)}", "{showOlderLabel(total - shown)}</Button><Link to=\"/wallet?page=2\">See more</Link><Button>"],
  ])("goes red on a mutation: %s", (_name, file, from, to) => {
    const code = sources.get(file)!;
    expect(code, `${file} no longer contains the mutation's anchor`).toContain(from);
    const mutated = new Map(sources).set(file, code.replace(from, to));
    expect(scan(mutated).offenders.length).toBeGreaterThan(0);
  });
});

/**
 * R15 X15-5 — the scan above looked for "Show more"-shaped labels, and bare stepper arrows got past
 * it: the Reports carousel's Next / Previous were `disabled` at their ends, so the press that brought
 * in the last slide dropped focus to `<body>`. An arrow is named by an ATTRIBUTE (it is an icon), so
 * this reads every interactive tag whose `aria-label` / `label` names a bare direction — "Next",
 * "Previous", "Prev", "Next week" — and requires that neither the tag nor, for a component defined
 * in the same file, that component's body sets `disabled`: at its end it says `aria-disabled` and
 * ignores the press (or hands focus on with `usePagedFocus`). A wizard's text "Next" (children, not
 * an attribute) moves to another step and is not an arrow.
 */
const ARROW = /^(?:Next|Previous|Prev)(?:\s+[a-z]+)?$/;
const DISABLED = /(?<![-\w])disabled(?:=|\s|\/?>)/;

/** The string literals an attribute's value can be: `"Next"`, or each literal in `{a ? "Previous week" : "Next week"}`. */
function attrLiterals(tag: string, name: string): string[] {
  const plain = tag.match(new RegExp(`(?<![-\\w])${name}="([^"]*)"`));
  if (plain) return [plain[1]];
  const expr = attr(tag, name);
  return expr === null ? [] : [...expr.matchAll(/["`]([^"`]*)["`]/g)].map((m) => m[1]);
}

/** The body of `function name(…) {…}` in `code`, when the file defines it. */
function localComponent(code: string, name: string): string | null {
  const at = code.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  const open = code.indexOf("{", code.indexOf(")", at));
  return braced(code, open);
}

function arrowScan(sources: ReadonlyMap<string, string>) {
  const arrows: { file: string; name: string; tag: string }[] = [];
  const offenders: string[] = [];
  for (const [file, code] of sources) {
    if (!file.endsWith(".tsx")) continue;
    for (const open of code.matchAll(/<([A-Za-z][\w.]*)\b/g)) {
      const tag = code.slice(open.index!, tagEnd(code, open.index!));
      const name = [...attrLiterals(tag, "aria-label"), ...attrLiterals(tag, "label")].find((l) => ARROW.test(l));
      if (name === undefined) continue;
      arrows.push({ file, name, tag: open[1] });
      if (resolves(attr(tag, "onClick"), file, enclosing(code, open.index!), sources)) continue;
      const body = /^[A-Z]/.test(open[1]) ? localComponent(code, open[1]) : null;
      if (DISABLED.test(tag.replace(/\bon\w+=\{[^}]*\}/g, "")) || (body !== null && DISABLED.test(body))) {
        offenders.push(`${file}: <${open[1]}> "${name}" can be disabled at its end`);
      }
    }
  }
  return { arrows, offenders };
}

describe("stepper arrows keep focus at their ends (R15 X15-5)", () => {
  const sources = sourcesNow();
  const { arrows, offenders } = arrowScan(sources);

  it("finds the arrows it guards (a scan that matches nothing proves nothing)", () => {
    const found = arrows.map((a) => `${a.file} ${a.name}`);
    expect(found).toEqual(expect.arrayContaining([
      "components/Carousel.tsx Previous", "components/Carousel.tsx Next", "components/ui/week-strip.tsx Previous week",
    ]));
  });

  it("no arrow is disabled at its end: it says aria-disabled and keeps focus", () => {
    expect(offenders).toEqual([]);
  });

  it.each([
    ["the carousel's arrow disabled again inside its component", "components/Carousel.tsx", "aria-disabled={atEnd || undefined}", "disabled={atEnd}"],
    ["the carousel's arrow handed `disabled` at the call site", "components/Carousel.tsx", "atEnd={active === 0}", "disabled={active === 0}"],
    ["the week strip's arrow disabled", "components/ui/week-strip.tsx", "aria-disabled={blocked || undefined}", "disabled={blocked}"],
  ])("goes red on a mutation: %s", (_name, file, from, to) => {
    const code = sources.get(file)!;
    expect(code, `${file} no longer contains the mutation's anchor`).toContain(from);
    expect(arrowScan(new Map(sources).set(file, code.replace(from, to))).offenders.length).toBeGreaterThan(0);
  });
});
