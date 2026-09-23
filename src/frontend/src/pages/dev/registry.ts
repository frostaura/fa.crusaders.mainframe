import type { ComponentType } from "react";
import { ButtonsSection } from "./ButtonsSection";
import { DataSection } from "./DataSection";
import { DateTimeSection } from "./DateTimeSection";
import { FeedbackSection } from "./FeedbackSection";
import { FieldsSection } from "./FieldsSection";
import { FoundationsSection } from "./FoundationsSection";
import { GridSection } from "./GridSection";
import { IconsSection } from "./IconsSection";
import { LegacySection } from "./LegacySection";
import { OverlaysSection } from "./OverlaysSection";
import { PassCardSection } from "./PassCardSection";
import { ShellSection } from "./ShellSection";
import { WatermarkSection } from "./WatermarkSection";

/**
 * The gallery's sections, in index order. `id` is the `?section=` deep link and the
 * `data-gallery-section` attribute `e2e/gallery.spec.ts` runs axe against — renaming one breaks a
 * bookmark and that spec, so add rather than rename.
 */
export type GalleryEntry = {
  id: string;
  title: string;
  description: string;
  Body: ComponentType;
};

export const SECTIONS: readonly GalleryEntry[] = [
  { id: "foundations", title: "Foundations", description: "Colour roles with measured contrast, type, radius, elevation, spacing, motion, layers.", Body: FoundationsSection },
  { id: "icons", title: "Icons", description: "Every icon in the barrel, in every weight the product uses.", Body: IconsSection },
  { id: "watermark", title: "Watermark", description: "The fingerprint on each surface, in each phase.", Body: WatermarkSection },
  { id: "buttons", title: "Buttons and links", description: "Variant by size by state, icon buttons, and the two looks of a link.", Body: ButtonsSection },
  { id: "fields", title: "Fields", description: "Input, textarea, select, member combobox, checkbox, radio, radio card, switch.", Body: FieldsSection },
  { id: "datetime", title: "Date and time", description: "Calendar, date picker, time select, week strip.", Body: DateTimeSection },
  { id: "overlays", title: "Overlays", description: "Dialog, sheet, popover, tooltip, dropdown menu, info popover.", Body: OverlaysSection },
  { id: "feedback", title: "Feedback", description: "Skeleton, toasts, alerts, progress, read states and the async posture.", Body: FeedbackSection },
  { id: "data", title: "Data", description: "Table, badges, avatars, card parts.", Body: DataSection },
  { id: "grid", title: "Booking grid", description: "Every slot state, the selection ring and the now-line.", Body: GridSection },
  { id: "shell", title: "Shell", description: "Page header variants, refresh and freshness, sections, the action bar.", Body: ShellSection },
  { id: "passcard", title: "Pass card", description: "Live, expiring and offline.", Body: PassCardSection },
  { id: "legacy", title: "Legacy tabs", description: "The pre-facelift segmented tabs, until My Code stops using them.", Body: LegacySection },
];

export function findSection(id: string | null): GalleryEntry | null {
  return SECTIONS.find((entry) => entry.id === id) ?? null;
}
