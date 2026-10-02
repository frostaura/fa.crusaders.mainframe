import { Minutes } from "../Minutes";
import { Warning } from "../ui/icons";
import { Skeleton } from "../ui/skeleton";
import { TextLink } from "../ui/text-link";
import { GROUP_PACKAGES } from "../../lib/groupsCopy";
import { formatMoney } from "../../lib/utils";
import type { PackagesRead } from "./groupDraft";

/** The route the packages themselves are made and changed on (P13 §3.1, the lead's page). */
export const PACKAGES_ROUTE = "/admin/packages";

/**
 * One group's own packages, read-only — on its card and in its sheet (P13 §3.5, §4.2).
 *
 * <p>
 * <b>Read-only here, by design.</b> A package is made, priced and archived on the Packages page,
 * where the whole shelf is in view; editing one from inside a group would hide what it does to
 * the shelf. So this lists name, minutes and rand price, and links there.
 * </p>
 *
 * <p>
 * <b>Its three states are its own.</b> The page reads the club's packages ONCE (never per card),
 * and a failure of that read is said here, in words, beside each group — it never takes the
 * groups themselves down, and it is never shown as "no packages", which is a different fact.
 * </p>
 */
export function GroupPackages({ groupId, packages }: { groupId: string; packages: PackagesRead }) {
  return (
    <div className="flex flex-col gap-1.5" data-group-packages={groupId}>
      <PackagesBody groupId={groupId} packages={packages} />
      <TextLink to={PACKAGES_ROUTE} className="self-start">{GROUP_PACKAGES.manage}</TextLink>
    </div>
  );
}

function PackagesBody({ groupId, packages }: { groupId: string; packages: PackagesRead }) {
  if (packages.status === "loading") {
    return (
      <div role="status" aria-busy="true" aria-label={GROUP_PACKAGES.reading} className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  // Primary ink beside a warning glyph, not warning ink: on an archived card's muted ground the
  // warning colour fell below 4.5:1 (axe, light theme).
  if (packages.status === "failed") {
    return (
      <p className="flex items-start gap-1.5 text-text-primary">
        <Warning aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-strong" />
        {GROUP_PACKAGES.failed}
      </p>
    );
  }
  const own = packages.items.filter((p) => p.group?.id === groupId && p.status === "active");
  if (own.length === 0) return <p>{GROUP_PACKAGES.none}</p>;
  return (
    <ul aria-label={GROUP_PACKAGES.title} className="flex flex-col gap-1">
      {own.map((p) => (
        <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-text-primary">{p.name}</span>
          <Minutes value={p.minutes} />
          <span className="tabular-nums">{formatMoney(p.price_zar)}</span>
        </li>
      ))}
    </ul>
  );
}
