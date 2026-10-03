import { formatMoney } from "./utils";
import { minutesSpoken } from "./minutes";
import { parseAmount, parseMinutesAmount } from "./amount";
import { amountProblemSentence } from "./amountCopy";
import { unsureWords } from "./lostReplyCopy";
import type { AdminPackage } from "./adminApi";

/**
 * The Packages page's words and its pure rules (`/admin/packages`, P13 contract §3.5, §4).
 *
 * <p>
 * A package is a number of whole minutes at a rand price, on ONE shelf: the club's (every member,
 * at their group's discount) or one group's own. Its shelf is fixed once it is created, and it is
 * retired, never deleted, because purchase rows name it. Tests query these constants.
 * </p>
 */

/** §2.3 / §3.5 bounds — the server's, said at the field before anything is sent. */
export const PACKAGE_LIMITS = {
  nameMax: 64,
  minutesMax: 60_000,
  priceMax: 100_000,
  /** Active packages per club (`package_limit_reached {max: 50}`). */
  activeMax: 50,
} as const;

/**
 * A package's saving, said one way everywhere it is a phrase (R6 L6-11): "Saves R50.00 (8%)" on
 * the desk's Sell sheet and the console's preview. The console's table cell drops the verb only
 * because its column is headed "Saves".
 */
export function savesWords(zar: string, pct: number | null): string {
  return pct ? `Saves ${zar} (${pct}%)` : `Saves ${zar}`;
}

/** The shelf a package is on: null = the club's, else the group's id. */
export type ShelfKey = string | null;

export const PACKAGES_COPY = {
  title: "Packages",
  description: "The minutes members buy, and what they pay. Club packages are on every member's shelf, at their "
    + "group's discount; a group's own packages are for its members only, at the price set here.",
  add: "Add package",
  refresh: "Refresh packages",
  readAction: "read the packages",
  readCaveat: "That does not mean the club has none — members may still be buying them.",
  groupsCaveat: "Couldn't read the groups, so packages are shown under their own group names and a new one can only go on the club's shelf.",
  emptyTitle: "No packages yet",
  emptyHint: "Add the club's first package — members cannot buy minutes until there is one.",
  archivedEmptyTitle: "Nothing retired",
  archivedEmptyHint: "A retired package leaves every shelf; it stays here because purchases name it.",
  viewLabel: "Show packages",
  viewActive: "On sale",
  viewArchived: "Retired",
  count: (active: number) => `${active} of ${PACKAGE_LIMITS.activeMax} on sale`,
  atLimit: `The club has ${PACKAGE_LIMITS.activeMax} packages on sale — the most there can be. Retire one to add another.`,
  clubShelf: "Every member",
  clubShelfHint: "The club's packages, at each member's group discount.",
  groupShelf: (group: string) => group,
  groupShelfHint: (group: string) => `Only ${group}'s members see these, at this price — no discount on top.`,
  listLabel: (shelf: string) => `${shelf} — packages`,
  columns: { name: "Package", minutes: "Minutes", price: "Price", perHour: "Per hour", saves: "Saves", order: "Order", actions: "Actions" },
  perHour: (zar: number) => `${formatMoney(zar)} an hour`,
  saves: (zar: number, pct: number | null) => (pct ? `${formatMoney(zar)} (${pct}%)` : formatMoney(zar)),
  noSaving: "—",
  baseline: "Smallest",
  edit: "Edit",
  editLabel: (name: string) => `Edit ${name}`,
  retire: "Retire",
  retireLabel: (name: string) => `Retire ${name}`,
  retireConfirm: (name: string) => `Retire ${name}? It leaves every shelf now. Open checkouts still complete at the price they were shown.`,
  retired: (name: string) => `${name} retired.`,
  retireAction: "retire the package",
  retiredOn: "Off sale",

  asideLabel: "Package",
  asideIdleTitle: "Choose a package",
  asideIdleHint: "Edit one from the list, or add one. Its price per hour and what it saves are worked out as you type.",
  addTitle: "Add a package",
  addDescription: "It goes on sale the moment it is saved.",
  editTitle: (name: string) => `Edit ${name}`,
  editDescription: "Changes apply to purchases from now on. A checkout already open keeps the price it was shown.",
  nameLabel: "Name",
  nameDescription: "What members see on their shelf — e.g. “5 hours”.",
  minutesLabel: "Minutes",
  minutesDescription: "Whole minutes. Use the hours below to fill it in.",
  hoursLabel: "Fill in hours",
  hoursChip: (hours: number) => `${hours} h`,
  minutesEcho: (minutes: number) => `= ${minutesSpoken(minutes)}`,
  priceLabel: "Price (R)",
  priceDescription: "What a member pays, in rand. A group discount comes off a club package's price.",
  shelfLabel: "Who can buy it",
  shelfFixed: "A package's shelf is fixed once it is created. To sell it to someone else, add a new package.",
  clubOption: "Every member (club package)",
  orderLabel: "Place on the shelf",
  orderDescription: "Lower comes first; packages at the same place are ordered by their minutes.",
  reasonLabel: "Why the change (optional)",
  reasonPlaceholder: "e.g. New season's prices",
  preview: "On the shelf",
  previewSaves: (zar: number, pct: number | null, base: string) => `${savesWords(formatMoney(zar), pct)} against ${base}.`,
  previewNoSaving: (base: string) => `No saving against ${base} — members would do as well buying that.`,
  previewIsBaseline: "The smallest package on this shelf: every other package's saving is measured against it.",
  previewAlone: "The only package on this shelf.",
  cancel: "Cancel",
  close: "Close",
  saveNew: "Add package",
  saveEdit: "Save package",
  added: (name: string) => `${name} added.`,
  saved: (name: string) => `${name} saved.`,
  addAction: "add the package",
  saveAction: "save the package",
  nameRequired: `Give the package a name, up to ${PACKAGE_LIMITS.nameMax} characters.`,
  orderInvalid: "The place on the shelf is a whole number, 0 or more.",
  errorCodes: {
    package_name_invalid: `Give the package a name, up to ${PACKAGE_LIMITS.nameMax} characters.`,
    package_minutes_invalid: `Minutes are a whole number from 1 to ${PACKAGE_LIMITS.minutesMax.toLocaleString("en-ZA")}.`,
    package_price_invalid: `The price is more than R0, at most ${formatMoney(PACKAGE_LIMITS.priceMax)}, in whole cents.`,
    package_sort_order_invalid: "The place on the shelf is a whole number, 0 or more.",
    package_group_invalid: "That group isn't one of the club's active groups any more. Choose again.",
    package_limit_reached: `The club already has ${PACKAGE_LIMITS.activeMax} packages on sale. Retire one first.`,
    package_name_taken: "There is already a package on sale with that name on this shelf. Choose another name.",
    package_group_immutable: "A package's shelf can't be changed once it is created.",
    package_archived: "That package has been retired, so it can't be changed.",
  } as Record<string, string>,
} as const;

export const PACKAGES_LOST = {
  add: (name: string) => unsureWords(`there is no ${name} yet`, `${name} was added`, "Packages"),
  save: (name: string) => unsureWords(`${name} still has its old details`, `${name} was saved`, "Packages"),
} as const;

// ---------------------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------------------

export function minutesComplaint(text: string): string | null {
  const parsed = parseMinutesAmount(text, { max: PACKAGE_LIMITS.minutesMax });
  return parsed.ok ? null : amountProblemSentence(parsed.problem, "minutes");
}

export function parsePackageMinutes(text: string): number | null {
  const parsed = parseMinutesAmount(text, { max: PACKAGE_LIMITS.minutesMax });
  return parsed.ok ? parsed.value : null;
}

export function priceComplaint(text: string): string | null {
  const parsed = parseAmount(text, { max: PACKAGE_LIMITS.priceMax });
  return parsed.ok ? null : amountProblemSentence(parsed.problem, "rand");
}

export function parsePrice(text: string): number | null {
  const parsed = parseAmount(text, { max: PACKAGE_LIMITS.priceMax });
  return parsed.ok ? parsed.value : null;
}

/** Rand per hour, rounded down to the cent — a buyer's figure (§1.2). */
export function perHour(priceZar: number, minutes: number): number | null {
  if (!(minutes > 0) || !(priceZar > 0)) return null;
  return Math.floor((priceZar * 60 * 100) / minutes) / 100;
}

// ---------------------------------------------------------------------------------------
// The saving (§4.3) — the server computes the member's; this is the same rule, for the console
// ---------------------------------------------------------------------------------------

export type ShelfItem = { id: string; name: string; minutes: number; price_zar: number };

/** The shelf's baseline: the smallest minutes; a tie goes to the lower price, then shelf order. */
export function baselineOf<T extends ShelfItem>(shelf: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of shelf) {
    if (!best || item.minutes < best.minutes || (item.minutes === best.minutes && item.price_zar < best.price_zar)) best = item;
  }
  return best;
}

/**
 * What `item` saves against the shelf's baseline (§4.3), or null: rand rounded down to the cent,
 * the percentage rounded down; null when the saving is not above zero, and the percentage null
 * when it rounds down to 0. The baseline itself saves nothing.
 */
export function savingOf(item: ShelfItem, baseline: ShelfItem | null): { zar: number; pct: number | null } | null {
  if (!baseline || baseline.id === item.id || baseline.minutes <= 0 || baseline.price_zar <= 0 || item.minutes <= 0) return null;
  const zar = Math.floor(((baseline.price_zar * item.minutes) / baseline.minutes - item.price_zar) * 100 + 1e-9) / 100;
  if (!(zar > 0)) return null;
  const pct = Math.floor(100 * (1 - (item.price_zar * baseline.minutes) / (item.minutes * baseline.price_zar)) + 1e-9);
  return { zar, pct: pct > 0 ? pct : null };
}

/** The ACTIVE packages on one shelf, the draft standing in for the package it edits (or added). */
export function shelfWith(packages: readonly AdminPackage[], shelf: ShelfKey, draft: ShelfItem): ShelfItem[] {
  const same = packages.filter((p) => p.status === "active" && (p.group?.id ?? null) === shelf && p.id !== draft.id);
  return [...same, draft];
}

/** The packages of one shelf, in the server's order: `sort_order`, then minutes, then name. */
export function shelfOrder(a: AdminPackage, b: AdminPackage): number {
  return a.sort_order - b.sort_order || a.minutes - b.minutes || a.name.localeCompare(b.name);
}
