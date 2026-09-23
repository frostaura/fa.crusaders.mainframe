import { ContrastPairs, Swatches } from "./ColourRoles";
import { MotionDemo } from "./MotionDemo";
import { Demo, ThemePair } from "./parts";
import { ElevationScale, RadiusScale, SpacingScale, TypeRecipes, ZScale } from "./Scales";

/** Foundations: colour, type, radius, elevation, spacing, motion and z-index. */
export function FoundationsSection() {
  return (
    <div className="flex flex-col gap-10">
      <Demo
        title="Colour roles"
        note="Each swatch paints the live CSS variable; the hex beside it is the value in lib/tokens.ts."
      >
        <ThemePair>{(theme) => <Swatches theme={theme} />}</ThemePair>
      </Demo>
      <Demo
        title="Contrast pairs"
        note="Ratios computed from the token values for the theme each panel is in. Text needs 4.5:1, a control edge or focus ring 3:1."
      >
        <ThemePair>{(theme) => <ContrastPairs theme={theme} />}</ThemePair>
      </Demo>
      <Demo title="Type recipes" note="lib/typography.ts. Archivo for display and h1, Figtree for the rest.">
        <ThemePair>{() => <TypeRecipes />}</ThemePair>
      </Demo>
      <Demo title="Radius">
        <ThemePair>{() => <RadiusScale />}</ThemePair>
      </Demo>
      <Demo title="Elevation" note="Dark elevation is a lighter surface plus a deeper shadow with a faint top highlight.">
        <ThemePair>{() => <ElevationScale />}</ThemePair>
      </Demo>
      <Demo title="Spacing" note="The Tailwind 4px scale: the allowed steps and the three named lengths.">
        <SpacingScale />
      </Demo>
      <Demo title="Motion" note="Named durations and easings only. With reduced motion requested, every bar jumps.">
        <MotionDemo />
      </Demo>
      <Demo title="Layers (z-index)" note="Named layers only, never an arbitrary value. Radix portals sit above modals so a picker opens over its dialog.">
        <ZScale />
      </Demo>
    </div>
  );
}
