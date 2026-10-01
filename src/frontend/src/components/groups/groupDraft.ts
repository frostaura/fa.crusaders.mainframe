import { useState } from "react";
import { paintedToWindows, windowsToPainted } from "./weekGrid";
import type { AdminPackage, MemberGroup, MemberGroupBody } from "../../lib/adminApi";
import {
  DISCOUNT_COPY, GROUP_SHEET, peakChoiceOf, peakSayOf, type DiscountProblem, type PaintedWeek, type PeakChoice,
} from "../../lib/groupsCopy";

/**
 * The group editor's draft — what the sheet holds while an admin edits, and the body it sends.
 *
 * <p>
 * <b>Both of a group's money-and-peak fields are tri-state on the wire, and the draft keeps them
 * so.</b> A package discount is "no say" (null) or a percentage; a peak say is grants / withholds /
 * no say. The peak say is always sent. The discount is sent ONLY when it changed (P13 §3.8: absent
 * leaves it unchanged, null clears it), so a rename never re-asserts a discount somebody else set
 * in the meantime.
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
  caps: Record<string, string | null>;
  windows: PaintedWeek;
  /** null = no say on package prices; a string = the percentage being typed ("10", "12.5"). */
  discount: string | null;
  peak: PeakChoice;
};

/**
 * The club's packages as the page read them — once for the whole page, never per card, and a
 * failure of that read is its own state (the rest of the page is unaffected by it).
 */
export type PackagesRead =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; items: readonly AdminPackage[] };

export type ClubContext = {
  club: PaintedWeek;
  sliceMinutes: number;
  clubCaps: { slotCap: number | null; minuteCap: number | null; advanceDays: number | null };
  peakHours: unknown;
  peakAdvanceHours: unknown;
  packages: PackagesRead;
};

/**
 * What a group save sends — picked rather than omitted, so the retired pricing and rate fields of
 * `MemberGroupBody` can never ride along (P13 §3.3: the server ignores them; the console must not
 * invent them).
 */
export type GroupSaveBody = Pick<MemberGroupBody, "name" | "description" | "caps" | "windows" | "packageDiscountBps" | "peakPriority">;

/** 1000 bps → "10", 1250 → "12.5": the percentage as the field shows it. */
export function percentText(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/**
 * Why a typed percentage cannot be sent, or null when it can. The server's bounds (0–10 000 bps,
 * a whole number) are the field's: 0–100 with at most two decimals, so every accepted figure is a
 * whole number of basis points.
 */
export function discountProblem(text: string): DiscountProblem | null {
  const typed = text.trim();
  if (typed === "") return "empty";
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(typed)) return "not_a_number";
  const value = Number(typed);
  if (!Number.isFinite(value)) return "not_a_number";
  if (value < 0 || value > 100) return "out_of_range";
  if ((typed.split(".")[1] ?? "").length > 2) return "too_precise";
  return null;
}

/** The typed percentage in basis points, or null when it is not a sendable figure. */
export function bpsFromText(text: string): number | null {
  if (discountProblem(text) !== null) return null;
  // Rounded, not truncated: 12.34 × 100 is 1233.9999… in binary, and the admin typed 1234.
  return Math.round(Number(text.trim()) * 100);
}

export function draftFrom(group: MemberGroup): Draft {
  const caps: Record<string, string | null> = {};
  for (const cap of CAPS) {
    const own = group.caps?.[cap.wire];
    caps[cap.key] = typeof own === "number" ? String(own) : null;
  }
  return {
    name: group.name,
    description: group.description ?? "",
    caps,
    windows: windowsToPainted(group.windows),
    discount: typeof group.package_discount_bps === "number" ? percentText(group.package_discount_bps) : null,
    peak: peakChoiceOf(group.peak_priority),
  };
}

/** Why Save cannot be pressed yet, field by field. Empty when the draft can be sent. */
export function draftProblems(draft: Draft): { name?: string; discount?: string } {
  const out: { name?: string; discount?: string } = {};
  if (draft.name.trim() === "") out.name = GROUP_SHEET.nameRequired;
  if (draft.discount !== null) {
    const problem = discountProblem(draft.discount);
    if (problem) out.discount = DISCOUNT_COPY.problems[problem];
  }
  return out;
}

/** The body for this draft, against the group it was opened on (the discount only when changed). */
export function bodyFrom(draft: Draft, group: MemberGroup): GroupSaveBody {
  const numberOrNull = (value: string | null) =>
    value === null || value.trim() === "" ? null : Number(value);
  const discount = draft.discount === null ? null : bpsFromText(draft.discount);
  return {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    caps: {
      maxSlotsPerDay: numberOrNull(draft.caps.maxSlotsPerDay),
      maxMinutesPerDay: numberOrNull(draft.caps.maxMinutesPerDay),
      advanceBookingDays: numberOrNull(draft.caps.advanceBookingDays),
    },
    // Wholesale, because the API replaces them wholesale. A PATCH carrying a subset would
    // silently drop every day it left out.
    windows: paintedToWindows(draft.windows),
    ...(discount === (group.package_discount_bps ?? null) ? {} : { packageDiscountBps: discount }),
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
