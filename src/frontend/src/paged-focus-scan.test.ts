import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R14 X14-1 — every paging button is on `usePagedFocus`, as a source scan.
 *
 * <p>
 * The last page of a "Show more" / "Show older" / "Load more" list takes its button away with it,
 * and focus falls to `<body>`: the next Tab starts at the skip link and a screen reader says
 * nothing. That fault was fixed list by list four rounds running (R8 X8-4, R9 X9-2, R12 X12-2,
 * R13 X13-1) and the wallet's "Show older" still had it in R14. So the class is closed here: a
 * `<Button>` whose label is a paging label — a literal, or a copy key whose value is one — must
 * take a bare handler (no inline arrow that could skip the hook) in a file that calls
 * `usePagedFocus`, or be on the allow-list below with the reason its own focus rule is sound.
 * </p>
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "pages/AdminLedger.tsx":
    "appends with flushSync, then focuses the first FRESH id's details button in the table's own sort order (R9 X9-2); usePagedFocus counts rows and cannot follow a sort",
  "pages/AdminDoorsLog.tsx":
    "focuses the first appended row AFTER the log's sort (C4), held in state — the same sort reason",
  "pages/AdminMembers.tsx":
    "reveals a client-side page with flushSync and focuses the first revealed row's link (R8 X8-4) — no fetch for the hook to wait on",
  "components/bookings/RecentGames.tsx":
    "a disclosure, not a pager: \"Show N more\" becomes \"Show fewer\" in place (aria-expanded), so the focused button never unmounts",
  "components/bookings/UpcomingGames.tsx":
    "the same disclosure as RecentGames — the button stays mounted as \"Show fewer\"",
  "components/members/MemberPicker.tsx":
    "its onMore is AdminMembers' flushSync reveal (above), which focuses the first revealed picker row",
};

const SRC = __dirname;
/** A label that pages: "Show more", "Show older (3 more)", "Load older scans", "Show 25 more", … */
const PAGING = /\b(?:Show|Load)\b[^"`\n<{}]*?(?:\$\{[^}]*\}[^"`\n<{}]*?)?\b(?:more|older)\b/;

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

/** Every copy key (or exported constant) whose value is a paging label. */
function pagingKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of files(join(SRC, "lib"), (n) => /\.ts$/.test(n))) {
    const pattern = /(?:^|[\s,{])(\w+)\s*(?::|=)\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*)?(["`])([^"`\n]*)\2/gm;
    for (const m of codeOf(file).matchAll(pattern)) if (PAGING.test(m[3])) keys.add(m[1]);
  }
  return keys;
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

type PagingButton = { file: string; label: string; onClick: string | null };

/** Every `<Button>`/`<button>` in `code` whose children carry a paging label. */
function pagingButtons(file: string, code: string, keys: Set<string>): PagingButton[] {
  const found: PagingButton[] = [];
  for (const open of code.matchAll(/<(Button|button)\b/g)) {
    // The tag ends at the first `>` outside braces (an arrow's `=>` sits inside `{…}`).
    let depth = 0;
    let end = open.index! + open[0].length;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      else if (code[end] === "}") depth--;
      else if (code[end] === ">" && depth === 0) break;
    }
    if (code[end - 1] === "/") continue;
    const attrs = code.slice(open.index!, end);
    const close = code.indexOf(`</${open[1]}>`, end);
    const children = code.slice(end + 1, close < 0 ? end + 1 : close);
    const viaKey = [...children.matchAll(/(?:\.|\{)\s*(\w+)\s*(?:\(|\})/g)].some((m) => keys.has(m[1]));
    const literal = PAGING.test(children.replace(/\{[^}]*\}/g, "")) || [...children.matchAll(/["`]([^"`]*)["`]/g)].some((m) => PAGING.test(m[1]));
    if (!viaKey && !literal) continue;
    const at = attrs.indexOf("onClick={");
    found.push({ file, label: children.trim().slice(0, 60), onClick: at < 0 ? null : braced(attrs, at + "onClick=".length).trim() });
  }
  return found;
}

describe("paging buttons hand focus on (R14 X14-1)", () => {
  const keys = pagingKeys();
  const all = files(SRC, (n) => /\.tsx$/.test(n)).flatMap((full) => {
    const code = codeOf(full);
    return pagingButtons(relative(SRC, full).split(sep).join("/"), code, keys).map((b) => ({ ...b, code }));
  });

  it("finds the paging labels and buttons it guards (a scan that matches nothing proves nothing)", () => {
    for (const key of ["showMore", "loadMore", "loadOlder", "HISTORY_SHOW_MORE", "showOlderLabel"]) expect(keys).toContain(key);
    const where = new Set(all.map((b) => b.file));
    for (const file of ["pages/Wallet.tsx", "components/inbox/InboxList.tsx", "pages/ProfileResults.tsx", "pages/AdminLedger.tsx"]) expect(where).toContain(file);
  });

  it("every paging button takes a usePagedFocus handler, or is allow-listed with its reason", () => {
    const offenders = all
      .filter((b) => !(b.file in ALLOWED))
      .filter((b) => b.onClick === null || !/^[\w.]+$/.test(b.onClick) || !/=\s*usePagedFocus\(/.test(b.code))
      .map((b) => `${b.file}: <Button onClick={${b.onClick ?? "∅"}}>${b.label}`);
    expect(offenders).toEqual([]);
  });

  it("the allow-list only names files that still have a paging button", () => {
    const where = new Set(all.map((b) => b.file));
    expect(Object.keys(ALLOWED).filter((file) => !where.has(file))).toEqual([]);
  });
});
