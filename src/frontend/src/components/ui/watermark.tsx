import "./watermark.css";
import { components, type WatermarkSurface } from "@/lib/tokens";

/**
 * The fingerprint watermark glyph (design-system.md, "The fingerprint watermark").
 *
 * <p>
 * <b>Do not import this file.</b> Only `ui/interactable.tsx` may — the watermark is a property
 * of an interactable surface, not a decoration a page places, and the placement rules (never on
 * door/gate/passkey/biometric/QR, destructive or armed surfaces, icon buttons, tabs, form
 * controls…) are enforced where `<Interactable watermark>` is used.
 * </p>
 *
 * <p>
 * <b>A masked box, not an inline SVG (perf lane, 2026-09-30).</b> The glyph used to be Phosphor's
 * `FingerprintSimple` (light weight) as a React SVG — one `<svg><path/></svg>` of ~1 kB of path
 * data per cell, 208 of them on a phone's day grid, and every one styled, laid out and painted on
 * each tap. It is now an empty `<span>` painted in `currentColor` through a CSS mask of the SAME
 * path (`watermark.css`, pinned byte-for-byte to Phosphor's light fingerprint by
 * `watermark.test.tsx`), so the look, the per-theme opacities and every hiding rule are unchanged
 * and the browser decodes the shape once.
 * </p>
 *
 * <p>
 * Decorative by construction: `aria-hidden`, no content and no role, `pointer-events: none` so a
 * tap lands on the host. Geometry comes from {@link components.watermarkGeometry}; opacity,
 * hiding and motion are in `watermark.css`.
 * </p>
 */
export function Watermark({ surface }: { surface: WatermarkSurface }) {
  const geometry = components.watermarkGeometry[surface];
  return (
    <span
      aria-hidden="true"
      className="wm-glyph"
      data-wm-glyph={surface}
      style={{ width: geometry.size, height: geometry.size, right: geometry.right, bottom: geometry.bottom }}
    />
  );
}
