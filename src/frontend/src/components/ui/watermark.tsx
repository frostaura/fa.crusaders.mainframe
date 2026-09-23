import "./watermark.css";
import { FingerprintSimple } from "./icons";
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
 * Decorative by construction: `aria-hidden`, `focusable="false"` (old Edge put every inline SVG
 * in the tab order), `pointer-events: none` so a tap lands on the host. Geometry comes from
 * {@link components.watermarkGeometry}; opacity, hiding and motion are in `watermark.css`.
 * </p>
 */
export function Watermark({ surface }: { surface: WatermarkSurface }) {
  const geometry = components.watermarkGeometry[surface];
  return (
    <FingerprintSimple
      aria-hidden="true"
      focusable="false"
      weight="light"
      size={geometry.size}
      color="currentColor"
      className="wm-glyph"
      data-wm-glyph={surface}
      style={{ right: geometry.right, bottom: geometry.bottom }}
    />
  );
}
