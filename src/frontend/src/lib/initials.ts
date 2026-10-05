/**
 * R15 J15-6 — a member's initials, the ONE helper every avatar draws with (the account menu, the
 * pass, the members list and picker, a player's face, `ui/avatar`'s named fallback). Five copies
 * each took the first letter of the first and last word, so "Roberta Smithson Jr." drew "RJ".
 *
 * <p>
 * It matches the court box's name rule (`Services/MemberDisplay.cs`, R12 D12-1 / R14 D14-5):
 * trimmed, the surname is the last word that is not a generational suffix (Jr, Sr, Junior —
 * "Júnior" too, compared without its accent — Filho, Neto, II, III, IV) and its initial is that
 * word's first LETTER ("Thabo (TJ) Mokoena" is TM, not T(). One word is one letter; blank is "?".
 * </p>
 */

const SUFFIXES: ReadonlySet<string> = new Set(["JR", "JR.", "SR", "SR.", "JUNIOR", "FILHO", "NETO", "II", "III", "IV"]);

/** Upper-cased without its accents, as `MemberDisplay` compares a suffix ("Júnior" is JUNIOR). */
function folded(word: string): string {
  return word.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
}

function firstLetter(word: string): string | null {
  return Array.from(word).find((c) => /\p{L}/u.test(c)) ?? null;
}

/** The surname's initial: the first letter of the last word after the first that is a name. */
function surnameInitial(words: string[]): string {
  for (let i = words.length - 1; i > 0; i--) {
    if (SUFFIXES.has(folded(words[i]))) continue;
    const letter = firstLetter(words[i]);
    if (letter) return letter;
  }
  return "";
}

/** "Dean Martin" → "DM"; "Roberta Smithson Jr." → "RS"; "cher" → "C"; blank → "?". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = firstLetter(words[0]) ?? Array.from(words[0])[0] ?? "";
  return (first + surnameInitial(words)).toLocaleUpperCase();
}
