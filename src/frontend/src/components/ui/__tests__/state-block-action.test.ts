import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { loadingSentence, STATE_BLOCK_VERBS, type StateBlockAction } from "../state-block";

/**
 * R1 (F3 follow-up) — StateBlock's `action` is read in TWO sentences: after "Couldn't" on a
 * failure and, turned into its gerund, as "Reading …" while loading. Call sites had passed a noun
 * phrase for one and a verb phrase for the other ("Reading read the …"; "Couldn't your wallet —").
 * The prop is typed now; this reads the source so that a value the compiler cannot see (a string
 * built at runtime, a `: string` constant) is caught too.
 */
const SRC = join(__dirname, "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const VERB = new RegExp(`^(${Object.keys(STATE_BLOCK_VERBS).join("|")}) `);

describe("StateBlock's action is one verb phrase everywhere", () => {
  it("derives the loading sentence from it", () => {
    expect(loadingSentence("read the fault list")).toBe("Reading the fault list…");
    expect(loadingSentence("load your wallet")).toBe("Loading your wallet…");
    expect(loadingSentence("set up your code")).toBe("Setting up your code…");
    expect(loadingSentence(undefined)).toBe("Reading…");
    expect(loadingSentence("download the CSV" satisfies StateBlockAction)).toBe("Downloading the CSV…");
  });

  it("never hands a StateBlock a literal that is not a verb phrase, or a choice between two", () => {
    const bad: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const block of text.matchAll(/<StateBlock\b[\s\S]*?\/?>/g)) {
        const literal = /\baction="([^"]*)"/.exec(block[0]);
        if (literal && !VERB.test(literal[1])) bad.push(`${relative(SRC, file)}: "${literal[1]}"`);
        if (/\baction=\{[^}]*\?[^}]*:/.test(block[0])) bad.push(`${relative(SRC, file)}: a ternary action`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps every read/load copy constant a verb phrase", () => {
    const bad: string[] = [];
    for (const file of sources(join(SRC, "lib"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\b(?:read\w*|load\w*|favourites|recent|search)Action: *"([^"]*)"/g)) {
        if (!VERB.test(m[1])) bad.push(`${relative(SRC, file)}: "${m[1]}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
