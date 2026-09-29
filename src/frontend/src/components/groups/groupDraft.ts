import { useState } from "react";
import { paintedToWindows, windowsToPainted } from "./weekGrid";
import type { GroupPricingMode, MemberGroup, MemberGroupBody } from "../../lib/adminApi";
import type { AdminCourt } from "../../lib/api";
import { rateProblem, round2AwayFromZero } from "../../lib/groupRules";
import {
  GROUP_SHEET, peakChoiceOf, peakSayOf, rateProblemSentence, type PaintedWeek, type PeakChoice,
} from "../../lib/groupsCopy";

/**
 * The group editor's draft — what the sheet holds while an admin edits, and the body it sends.
 *
 * <p>
 * <b>Both D2 fields are tri-state on the wire, and the draft keeps them so.</b> A rate is
 * "inherit the club's" (null) or a figure; a peak say is grants / withholds / no say. The body
 * always sends both: the PATCH distinguishes absent from null, and a draft that dropped an
 * unchanged field would be indistinguishable from one that meant "unchanged" by accident.
 * </p>
 */

/** Which caps exist, how they are labelled, and what the club's own value for each is called. */
export const CAPS = [
  { key: "maxSlotsPerDay", wire: "max_slots_per_day", noun: "slots a day", club: "slotCap" },
  { key: "maxMinutesPerDay", wire: "max_minutes_per_day", noun: "minutes a day", club: "minuteCap" },
  { key: "advanceBookingDays", wire: "advance_booking_days", noun: "days ahead", club: "advanceDays" },
] as const;

export type Draft = {
  name: string;
  description: string;
  mode: GroupPricingMode;
  /** Typed as a decimal multiple — 0.75, not 7500. Converted to basis points on the way out. */
  multiplier: string;
  flatPrice: string;
  caps: Record<string, string | null>;
  windows: PaintedWeek;
  /** null = use the club's rate; a string = the figure being typed. */
  rate: string | null;
  peak: PeakChoice;
};

export type ClubContext = {
  club: PaintedWeek;
  sliceMinutes: number;
  /**
   * The distinct slot prices of the club's courts in use, lowest first — null while the courts
   * have not been read. Each court carries its own price; the club-wide `slice_price_credits`
   * is only the default for a NEW court and quoting it here was review round 1's F3.3.
   */
  courtPrices: readonly number[] | null;
  clubCaps: { slotCap: number | null; minuteCap: number | null; advanceDays: number | null };
  clubRate: number | null | undefined;
  blockZar: number | null | undefined;
  peakHours: unknown;
  peakAdvanceHours: unknown;
};

export function draftFrom(group: MemberGroup): Draft {
  const caps: Record<string, string | null> = {};
  for (const cap of CAPS) {
    const own = group.caps?.[cap.wire];
    caps[cap.key] = typeof own === "number" ? String(own) : null;
  }
  return {
    name: group.name,
    description: group.description ?? "",
    mode: group.pricing?.mode ?? "inherit_court",
    multiplier: String(Number(((group.pricing?.multiplier_bps ?? 10_000) / 10_000).toFixed(4))),
    flatPrice: group.pricing?.flat_slice_price_credits == null
      ? "" : String(group.pricing.flat_slice_price_credits),
    caps,
    windows: windowsToPainted(group.windows),
    rate: typeof group.credits_per_zar === "number" ? String(group.credits_per_zar) : null,
    peak: peakChoiceOf(group.peak_priority),
  };
}

/** The distinct prices of the courts in use, lowest first; null when the courts are unread. */
export function courtPricesOf(courts: readonly AdminCourt[] | null): readonly number[] | null {
  if (!courts) return null;
  const prices = courts
    .filter((c) => c.is_active)
    .map((c) => c.slice_price_credits)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  return [...new Set(prices)].sort((a, b) => a - b);
}

/**
 * The figure beside the choice, once per court price: `unknown` when the choice cannot be
 * priced (a multiplier or flat price mid-typing), and `credits` empty when the courts are unread.
 */
export function pricesOf(draft: Draft, courtPrices: readonly number[] | null): { credits: number[]; unknown: boolean } {
  if (draft.mode === "flat_per_slice") {
    const flat = priceOf(draft, 0);
    return { credits: flat.unknown ? [] : [flat.credits], unknown: flat.unknown };
  }
  const each = (courtPrices ?? []).map((p) => priceOf(draft, p));
  return { credits: each.map((p) => p.credits), unknown: each.some((p) => p.unknown) };
}

/** What one slot costs under the choice currently on screen, against ONE court price. */
export function priceOf(draft: Draft, courtPrice: number): { credits: number; unknown: boolean } {
  if (draft.mode === "inherit_court") return { credits: courtPrice, unknown: false };
  if (draft.mode === "multiplier") {
    const multiple = Number(draft.multiplier);
    if (!Number.isFinite(multiple)) return { credits: 0, unknown: true };
    return { credits: Math.max(0, round2AwayFromZero(courtPrice * multiple)), unknown: false };
  }
  const flat = Number(draft.flatPrice);
  if (draft.flatPrice.trim() === "" || !Number.isFinite(flat)) return { credits: 0, unknown: true };
  return { credits: Math.max(0, flat), unknown: false };
}

/** Why Save cannot be pressed yet, field by field. Empty when the draft can be sent. */
export function draftProblems(draft: Draft): { name?: string; rate?: string } {
  const out: { name?: string; rate?: string } = {};
  if (draft.name.trim() === "") out.name = GROUP_SHEET.nameRequired;
  if (draft.rate !== null) {
    const problem = rateProblem(draft.rate);
    if (problem) out.rate = rateProblemSentence(problem);
  }
  return out;
}

export function bodyFrom(draft: Draft): MemberGroupBody {
  const numberOrNull = (value: string | null) =>
    value === null || value.trim() === "" ? null : Number(value);
  return {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    pricing: {
      mode: draft.mode,
      ...(draft.mode === "multiplier"
        ? { multiplierBps: Math.round(Number(draft.multiplier) * 10_000) }
        : {}),
      ...(draft.mode === "flat_per_slice" ? { flatSlicePriceCredits: Number(draft.flatPrice) } : {}),
    },
    caps: {
      maxSlotsPerDay: numberOrNull(draft.caps.maxSlotsPerDay),
      maxMinutesPerDay: numberOrNull(draft.caps.maxMinutesPerDay),
      advanceBookingDays: numberOrNull(draft.caps.advanceBookingDays),
    },
    // Wholesale, because the API replaces them wholesale. A PATCH carrying a subset would
    // silently drop every day it left out.
    windows: paintedToWindows(draft.windows),
    creditsPerZar: draft.rate === null ? null : Number(draft.rate.trim()),
    peakPriority: peakSayOf(draft.peak),
  };
}

export type SetDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => void;

/** The draft, and the one setter every section writes through. */
export function useGroupDraft(group: MemberGroup) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(group));
  const set: SetDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  return { draft, set };
}

