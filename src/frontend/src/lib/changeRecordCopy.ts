import { settingDef } from "./settingsSchema";
import { clubCurrencySymbol } from "./currency";

/**
 * The change record's own words — review round 1, F3.2.
 *
 * <p>
 * The headline and the diff are composed on the SERVER from a closed dictionary; this module
 * only covers what the server's words leave raw. A settings change's diff names the stored key
 * (`credits_per_zar_regular`), which is the one name an admin never sees on the Settings page —
 * so a setting is labelled with the Settings page's own caption, and anything else falls back to
 * the server's label, then to the key in words.
 * </p>
 */
export const CHANGES_PAGE = {
  showing: (shown: number, total: number) => `Showing ${shown} of ${total}.`,
  loadMore: "Load more",
  loadMoreAction: "read more of the change record",
} as const;

/** A key in words: "member_code.reset" → "Member code reset". */
export function inWords(key: string): string {
  const words = key.replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** The headline, or — for an action the server has no sentence for yet — the action in words. */
export function changeHeadline(row: { headline?: string | null; action?: string | null }): string {
  return row.headline || inWords(row.action ?? "");
}

/** A diff row's caption: the Settings page's own label for a setting, else the server's label. */
export function changeFieldLabel(
  row: { area?: string | null; action?: string | null },
  change: { field: string; label?: string | null },
): string {
  const isSetting = row.area === "setting" || (row.action ?? "").startsWith("settings.");
  const def = isSetting ? settingDef(change.field) : undefined;
  if (def) return def.label.replaceAll("{currency}", clubCurrencySymbol());
  return change.label || inWords(change.field);
}
