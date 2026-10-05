import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialsOf } from "./initials";

/** R15 J15-6 — one initials rule, the court box's (`MemberDisplay`): suffixes are not surnames. */
describe("initialsOf (R15 J15-6)", () => {
  it.each([
    ["Dean Martin", "DM"],
    ["Ada King Lovelace", "AL"],
    ["cher", "C"],
    ["  ", "?"],
    ["  Mia   Jones  ", "MJ"],
    ["Roberta Smithson Jr.", "RS"],
    ["Roberta Smithson Jr", "RS"],
    ["Owen Smith Sr.", "OS"],
    ["Henry Ford II", "HF"],
    ["Henry Ford III", "HF"],
    ["Louis Capet IV", "LC"],
    ["João da Silva Júnior", "JS"],
    ["João da Silva Junior", "JS"],
    ["Paulo Souza Filho", "PS"],
    ["Thabo (TJ) Mokoena", "TM"],
    ["Zoë Nel", "ZN"],
    ["élise dubois", "ÉD"],
    ["Jr", "J"],
  ])("%s → %s", (name, want) => {
    expect(initialsOf(name)).toBe(want);
  });
});

/** The five copies are gone: no other file in src defines its own initials function. */
describe("one initials helper (R15 J15-6)", () => {
  const root = join(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(root);

  it("is defined only in lib/initials.ts", () => {
    const definers = files.filter((f) => /function\s+initials(Of)?\s*\(/.test(readFileSync(f, "utf8")));
    expect(definers.map((f) => f.slice(root.length + 1))).toEqual(["lib/initials.ts"]);
  });
});
