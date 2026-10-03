import { ApiError, OfflineError, type MinutesShelf, type ShelfPackage } from "./api";
import { outcomeUnknown } from "./lostReply";
import { minutesSpoken } from "./minutes";
import { savesWords } from "./packagesCopy";
import { formatMoney } from "./utils";

/**
 * Buying minutes (P13 §3.4, §4): the member's package shelf, in words, and the pure figures the
 * shelf page draws.
 *
 * <p>
 * <b>A member buys a PACKAGE, never an amount.</b> The old screen took any rand figure in blocks,
 * converted it at a rate and capped it per member; Dean removed the rate and the cap (§11.1). So
 * there is no free-amount field, no limit and no rate here — only packages the club priced, each
 * with its minutes in human form, its rand price, the member's group discount on club packages,
 * and the saving against the shelf's smallest package (§4.3, computed on the server).
 * </p>
 *
 * <p>
 * Minutes are written through `lib/minutes` ("5 h", "1 h 30 min"); rand through `formatMoney`
 * with the club's symbol. A minutes figure never wears a currency symbol and a rand figure always
 * does.
 * </p>
 */

/** A discount in basis points as a percentage a person reads: 1000 → "10%", 1250 → "12.5%". */
export function discountPercent(bps: number): string {
  const pct = Math.trunc(bps) / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

/**
 * What one hour costs in this package, rounded down to the cent in the buyer's favour (§1.2) — the
 * figure that makes two packages comparable at a glance. Null for a package of no minutes.
 */
export function pricePerHour(pkg: Pick<ShelfPackage, "minutes" | "price_zar">): number | null {
  if (!(pkg.minutes > 0)) return null;
  return Math.floor((pkg.price_zar * 60 * 100) / pkg.minutes) / 100;
}

/**
 * The shelf's baseline — the package the saving is measured against (§4.3): the fewest minutes,
 * a tie to the lower price, then shelf order. Used only to NAME it in the saving's sentence; the
 * saving itself is the server's.
 */
export function baselineOf(packages: readonly ShelfPackage[]): ShelfPackage | null {
  let best: ShelfPackage | null = null;
  for (const p of packages) {
    if (!best || p.minutes < best.minutes || (p.minutes === best.minutes && p.price_zar < best.price_zar)) best = p;
  }
  return best;
}

/** A shelf split for the page: each group's own packages under its name, then the club's. */
export type ShelfSection = { key: string; group: { id: string; name: string } | null; packages: ShelfPackage[] };

/**
 * Group packages first, one section per group (Dean's answer 2: a member of a group with its own
 * packages sees BOTH those and the club's), then the club's — each in the server's shelf order.
 */
export function shelfSections(packages: readonly ShelfPackage[]): ShelfSection[] {
  const groups = new Map<string, ShelfSection>();
  const club: ShelfPackage[] = [];
  for (const p of packages) {
    if (p.source === "group" && p.group) {
      const section = groups.get(p.group.id) ?? { key: `group:${p.group.id}`, group: p.group, packages: [] };
      section.packages.push(p);
      groups.set(p.group.id, section);
    } else {
      club.push(p);
    }
  }
  const sections = [...groups.values()];
  if (club.length > 0) sections.push({ key: "club", group: null, packages: club });
  return sections;
}

/** The package as the shelf now has it, after a `package_price_changed` refusal restated it. */
export function withRestated(shelf: MinutesShelf, restated: ShelfPackage): MinutesShelf {
  return { ...shelf, packages: shelf.packages.map((p) => (p.id === restated.id ? restated : p)) };
}

/**
 * R6 J6-7 — a package that costs nothing at this member's discount. PayFast takes no R0.00 payment
 * (`package_price_zero`), so it is said on the card and never offered to Continue.
 */
export function isFreeHere(p: Pick<ShelfPackage, "price_zar">): boolean {
  return p.price_zar <= 0;
}

const BUY_COPY_FREE = "Free at your discount — ask at the desk";

export const BUY_COPY = {
  title: "Buy minutes",
  description: "Pick a package and pay in rand with PayFast. The minutes land in your wallet and never expire.",
  readAction: "load the club's packages",
  /** Dean's answer 2 — group packages are named for the group, club packages for the club. */
  groupSection: (name: string) => `${name} packages`,
  groupSectionHelp: (name: string) => `Only for ${name} members.`,
  clubSection: "Club packages",
  /** Said once, above the club section, when a group discount applies to it. */
  discountNote: (pct: string, group: string) => `${pct} off club packages — your ${group} discount, already in the prices below.`,
  shelfLabel: "Packages",
  emptyTitle: "No packages to buy yet",
  emptyHint: "The club hasn't set up any minutes packages. Ask at the desk — they can add minutes for you.",
  /** The saving badge, against the smallest package (§4.3). */
  /** R6 L6-11 — one wording for a saving everywhere (`savesWords`): "Saves R50.00 (8%)". */
  save: (zar: number, pct: number | null) => savesWords(formatMoney(zar), pct),
  perHour: (zar: number) => `${formatMoney(zar)} an hour`,
  wasPrice: (zar: number) => `was ${formatMoney(zar)}`,
  discountBadge: (pct: string) => `${pct} off`,
  summaryLabel: "Your purchase",
  pickOne: "Pick a package to see what you pay.",
  youGet: "You get",
  listPrice: "Price",
  discountLine: (pct: string, group: string) => `${group} discount (${pct})`,
  youPay: "You pay",
  cta: "Continue to PayFast",
  ctaPending: "Starting your payment…",
  promise: "The price is fixed the moment you continue, and can't change while you're at PayFast. If the club changes it while this page is open, we'll show you the new price first.",
  back: "Back",
  /** R6 J6-7 — a package the member's discount makes free cannot go through PayFast; the desk adds it. */
  freeAtDesk: BUY_COPY_FREE,
  /** The accessible description of one card — the visible card is a picture of the same facts. */
  spoken: (p: ShelfPackage, baseline: ShelfPackage | null) => {
    const parts = [`${minutesSpoken(p.minutes)} for ${formatMoney(p.price_zar)}`];
    if (p.discount_bps > 0) parts.push(`${discountPercent(p.discount_bps)} off ${formatMoney(p.list_price_zar)}`);
    if (p.saving_zar !== null && p.saving_zar > 0 && baseline) {
      const pct = p.saving_pct !== null ? ` (${p.saving_pct}%)` : "";
      parts.push(`saves ${formatMoney(p.saving_zar)}${pct} against buying ${minutesSpoken(baseline.minutes)} at a time`);
    }
    if (isFreeHere(p)) parts.push(BUY_COPY_FREE);
    return `${parts.join(", ")}.`;
  },
  /** The saving's visible sentence under the badge. */
  savingLine: (baseline: ShelfPackage) => `against buying ${minutesSpoken(baseline.minutes)} at a time`,
} as const;

/** What a refused or unanswered purchase says. Every branch says whether anything was charged. */
export const BUY_SAID = {
  priceChanged: (p: ShelfPackage) =>
    `The club changed the price of ${p.name} while this page was open, so nothing was sent to PayFast. It's now ${formatMoney(p.price_zar)} — press Continue again to pay that.`,
  unavailable: "That package isn't on your shelf any more, so nothing was sent to PayFast. The list has been refreshed.",
  priceZero: "At your discount this package costs nothing, so it can't go through PayFast. Ask at the desk and they'll add it for you.",
  notConfigured: "Payments aren't set up for this club yet — please ask an admin. Nothing was charged.",
  providerFailed: "PayFast wouldn't start this payment. Nothing was charged — try again in a minute.",
  offline: "Buying needs a connection. Nothing was sent — try again when you're back online.",
  failed: "We couldn't start this payment. Nothing was charged — try again in a moment.",
  lostStarted: "The reply got lost, so the club's record was checked: a purchase was started but we couldn't take you to PayFast. Nothing was charged — cancel it below, then try again.",
  lostNothing: "The reply got lost, so the club's record was checked: nothing was started and nothing was charged. Try again.",
  lostUnknown: "The reply got lost and the club couldn't be checked either. Nothing was charged on this page — look at the list below in a moment before trying again.",
} as const;

/** How a press of Continue ended, when it did not end at PayFast. */
export type BuyRefusal =
  | { kind: "price_changed"; restated: ShelfPackage }
  | { kind: "unavailable" }
  | { kind: "sentence"; text: string }
  | { kind: "unknown" };

function codeOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || typeof error.payload !== "object" || error.payload === null) return null;
  const code = (error.payload as Record<string, unknown>).error;
  return typeof code === "string" ? code : null;
}

function restatedOf(error: unknown): ShelfPackage | null {
  const raw = error instanceof ApiError && typeof error.payload === "object" && error.payload !== null
    ? (error.payload as Record<string, unknown>).package : null;
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Partial<ShelfPackage>;
  return typeof p.id === "string" && typeof p.price_zar === "number" && typeof p.minutes === "number" ? (p as ShelfPackage) : null;
}

const SENTENCE_BY_CODE: Record<string, string> = {
  package_price_zero: BUY_SAID.priceZero,
  payments_not_configured: BUY_SAID.notConfigured,
  provider_register_failed: BUY_SAID.providerFailed,
};

/**
 * Classifies a failed `POST /minutes/purchase`. A coded answer is the club's word, even a 5xx one
 * (`provider_register_failed` is 502, `payments_not_configured` 503): it is not a lost reply.
 * Only an uncoded 5xx, a timeout or a dropped connection is `unknown` — the caller reads the shelf
 * back before it says anything.
 */
export function buyRefusal(error: unknown): BuyRefusal {
  if (error instanceof OfflineError) return { kind: "sentence", text: BUY_SAID.offline };
  const code = codeOf(error);
  if (code === "package_price_changed") {
    const restated = restatedOf(error);
    return restated ? { kind: "price_changed", restated } : { kind: "unavailable" };
  }
  if (code === "package_unavailable") return { kind: "unavailable" };
  if (code && SENTENCE_BY_CODE[code]) return { kind: "sentence", text: SENTENCE_BY_CODE[code] };
  if (outcomeUnknown(error)) return { kind: "unknown" };
  return { kind: "sentence", text: BUY_SAID.failed };
}
