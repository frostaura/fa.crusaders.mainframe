import { Link } from "react-router-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { TextLink } from "@/components/ui/text-link";
import { ArrowsClockwise, DotsThree, Plus, Trash } from "@/components/ui/icons";
import { Demo, Specimen, ThemePair } from "./parts";

/** Every button variant × size × state, the icon buttons, and the two looks a link may take. */
type Variant = NonNullable<ButtonProps["variant"]>;

const VARIANTS: readonly Variant[] = ["primary", "secondary", "outline", "ghost", "danger", "danger-soft"];

const VARIANT_LABEL: Record<Variant, string> = {
  primary: "Book",
  secondary: "Buy minutes",
  outline: "Export",
  ghost: "Skip",
  danger: "Delete board",
  "danger-soft": "Cancel booking",
};

function VariantRow({ variant }: { variant: Variant }) {
  const label = VARIANT_LABEL[variant];
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs text-text-secondary">{variant}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Specimen label="sm"><Button variant={variant} size="sm">{label}</Button></Specimen>
        <Specimen label="md"><Button variant={variant}>{label}</Button></Specimen>
        <Specimen label="lg"><Button variant={variant} size="lg">{label}</Button></Specimen>
        <Specimen label="icon"><Button variant={variant} icon={<Plus aria-hidden="true" />}>{label}</Button></Specimen>
        <Specimen label="pending"><Button variant={variant} pending>{label}</Button></Specimen>
        <Specimen label="disabled"><Button variant={variant} disabled>{label}</Button></Specimen>
      </div>
    </div>
  );
}

function IconButtons() {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Specimen label="icon-sm"><IconButton label="Refresh" size="icon-sm"><ArrowsClockwise /></IconButton></Specimen>
      <Specimen label="icon"><IconButton label="More actions"><DotsThree /></IconButton></Specimen>
      <Specimen label="icon-lg"><IconButton label="Add a slot" size="icon-lg" variant="secondary"><Plus /></IconButton></Specimen>
      <Specimen label="outline"><IconButton label="Delete" variant="outline"><Trash /></IconButton></Specimen>
      <Specimen label="pending"><IconButton label="Refreshing" pending><ArrowsClockwise /></IconButton></Specimen>
    </div>
  );
}

function Links() {
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-prose text-sm text-text-primary">
        An inline link sits in running text, like{" "}
        <TextLink to="?section=buttons">how booking works</TextLink>, and is underlined.
      </p>
      <TextLink variant="standalone" to="?section=buttons">See all bookings</TextLink>
      <div className="flex flex-wrap gap-3">
        <Button asChild variant="secondary">
          <Link to="?section=buttons">Navigation CTA (a link)</Link>
        </Button>
        <Button block className="sm:w-auto">Block on a phone</Button>
      </div>
    </div>
  );
}

export function ButtonsSection() {
  return (
    <div className="flex flex-col gap-10">
      <Demo title="Buttons" note="No glyph at rest. Pending keeps the label and the width, and stays focusable.">
        <ThemePair>
          {() => (
            <div className="flex flex-col gap-5">
              {VARIANTS.map((variant) => <VariantRow key={variant} variant={variant} />)}
            </div>
          )}
        </ThemePair>
      </Demo>
      <Demo title="Icon buttons" note="The label is required: it is the accessible name and the tooltip.">
        <ThemePair>{() => <IconButtons />}</ThemePair>
      </Demo>
      <Demo title="Links" note="Navigation is a link, an action is a button. A link looks like a button only as a navigation CTA.">
        <ThemePair>{() => <Links />}</ThemePair>
      </Demo>
    </div>
  );
}
