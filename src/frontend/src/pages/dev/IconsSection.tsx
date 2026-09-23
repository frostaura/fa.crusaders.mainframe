import * as barrel from "@/components/ui/icons";
import type { Icon, IconWeight } from "@/components/ui/icons";
import { Demo, ThemePair } from "./parts";

/**
 * Every icon the barrel exports, in the four weights the product uses. Read from the barrel
 * itself (each icon is exported as `<Name>Icon` and as `<Name>`; the `…Icon` names are the set),
 * so an icon added to the barrel appears here with no edit to this file.
 */
const WEIGHTS: readonly IconWeight[] = ["regular", "bold", "fill", "duotone"];

export const BARREL_ICONS: ReadonlyArray<[string, Icon]> = Object.entries(barrel)
  .filter(([name, value]) => /Icon$/.test(name) && value !== null && typeof value === "object")
  .map(([name, value]) => [name.replace(/Icon$/, ""), value as Icon] as [string, Icon])
  .sort((a, b) => a[0].localeCompare(b[0]));

function IconRow({ name, Glyph }: { name: string; Glyph: Icon }) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-bg-surface px-3 py-2">
      <span className="min-w-0 break-words text-xs font-medium text-text-primary">{name}</span>
      <span className="flex shrink-0 items-center gap-2 text-text-primary">
        {WEIGHTS.map((weight) => (
          <Glyph key={weight} size={20} weight={weight} aria-hidden="true" data-weight={weight} />
        ))}
      </span>
    </li>
  );
}

export function IconsSection() {
  return (
    <Demo
      title={`${BARREL_ICONS.length} icons × ${WEIGHTS.length} weights`}
      note="Left to right in each row: regular, bold, fill, duotone. Import only from components/ui/icons."
    >
      <ThemePair>
        {() => (
          <ul className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            {BARREL_ICONS.map(([name, Glyph]) => <IconRow key={name} name={name} Glyph={Glyph} />)}
          </ul>
        )}
      </ThemePair>
    </Demo>
  );
}
