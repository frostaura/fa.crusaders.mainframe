import type { ReactNode } from "react";
import type { MinutesShelf, ShelfPackage } from "../lib/api";
import { minutesCompact } from "../lib/minutes";
import { cn, formatMoney } from "../lib/utils";
import {
  BUY_COPY, baselineOf, discountPercent, pricePerHour, shelfSections, type ShelfSection,
} from "../lib/topUpShelf";
import { Minutes } from "../components/Minutes";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/card";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import { Skeleton } from "../components/ui/skeleton";
import { Tag, UsersThree } from "../components/ui/icons";

/**
 * The shelf itself (P13 §4.2): one radio card per package, the group's own packages under the
 * group's name and the club's under the club's (Dean's answer 2), then a summary of the chosen one.
 *
 * <p>
 * <b>A choice, then one verb.</b> The cards are a single-choice radio group (Radix roving focus:
 * Tab enters once, the arrows move and select) and the one primary action — Continue to PayFast —
 * lives in the summary, which stands beside the shelf on a wide screen and is docked in thumb reach
 * on a phone. A card is a picture of the facts; its accessible name is the package and its
 * description says the same facts in words (`BUY_COPY.spoken`), so "5 h" is heard as "5 hours".
 * </p>
 */

/** The cards as they will look while the shelf is read: the page's own shape, never "Loading…". */
export function ShelfSkeleton() {
  return (
    <div className="grid gap-4 @[40rem]/page:grid-cols-2 @[72rem]/page:grid-cols-3" aria-hidden="true">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
    </div>
  );
}

type ShelfProps = {
  shelf: MinutesShelf;
  selected: string | null;
  onSelect: (id: string) => void;
};

/** Every section of the shelf, as ONE radio group — a member picks one package, whichever shelf. */
export function ShelfCards({ shelf, selected, onSelect }: ShelfProps) {
  const sections = shelfSections(shelf.packages);
  const baseline = baselineOf(shelf.packages);
  return (
    <RadioGroup
      aria-label={BUY_COPY.shelfLabel}
      value={selected ?? ""}
      onValueChange={(id) => { if (id) onSelect(id); }}
      className="gap-8"
    >
      {sections.map((section) => (
        <ShelfSectionBlock key={section.key} section={section} discount={shelf.discount} baseline={baseline} />
      ))}
    </RadioGroup>
  );
}

function ShelfSectionBlock({ section, discount, baseline }: {
  section: ShelfSection; discount: MinutesShelf["discount"]; baseline: ShelfPackage | null;
}) {
  const heading = section.group ? BUY_COPY.groupSection(section.group.name) : BUY_COPY.clubSection;
  const headingId = `shelf-${section.key.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold text-text-primary">
          {section.group ? <UsersThree size={18} aria-hidden="true" className="text-accent-strong" /> : null}
          {heading}
        </h2>
        {section.group ? <p className="text-sm text-text-secondary">{BUY_COPY.groupSectionHelp(section.group.name)}</p> : null}
        {!section.group && discount && discount.bps > 0 ? (
          <p className="flex items-center gap-1.5 text-sm font-medium text-success-strong" data-shelf-discount="">
            <Tag size={16} aria-hidden="true" />
            {BUY_COPY.discountNote(discountPercent(discount.bps), discount.group.name)}
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 @[40rem]/page:grid-cols-2 @[72rem]/page:grid-cols-3">
        {section.packages.map((p) => <PackageCard key={p.id} pkg={p} baseline={baseline} />)}
      </div>
    </section>
  );
}

/**
 * One package: the minutes big (the thing being bought), the name, the price and what it was
 * before the member's discount, the hourly figure that makes packages comparable, and the saving
 * against the smallest package as a badge plus the rand it amounts to.
 */
function PackageCard({ pkg, baseline }: { pkg: ShelfPackage; baseline: ShelfPackage | null }) {
  const saving = pkg.saving_zar !== null && pkg.saving_zar > 0 && baseline && baseline.id !== pkg.id;
  const perHour = pricePerHour(pkg);
  return (
    <RadioCard
      value={pkg.id}
      data-package-id={pkg.id}
      title={pkg.name}
      description={<span className="sr-only">{BUY_COPY.spoken(pkg, baseline)}</span>}
      className="h-full p-5"
    >
      <span aria-hidden="true" className="flex flex-col gap-3 pt-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-3xl font-bold tracking-tight tabular-nums text-text-primary">{minutesCompact(pkg.minutes)}</span>
          {pkg.saving_pct !== null && saving ? <Badge tone="success">{BUY_COPY.save(pkg.saving_pct)}</Badge> : null}
        </span>
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xl font-semibold tabular-nums text-text-primary">{formatMoney(pkg.price_zar)}</span>
          {pkg.discount_bps > 0 ? (
            <span className="text-sm tabular-nums text-text-muted line-through">{BUY_COPY.wasPrice(pkg.list_price_zar)}</span>
          ) : null}
        </span>
        <span className="flex flex-col gap-0.5 text-sm text-text-secondary">
          {perHour !== null ? <span className="tabular-nums">{BUY_COPY.perHour(perHour)}</span> : null}
          {saving && baseline ? <span className="text-success-strong">{BUY_COPY.savingLine(pkg.saving_zar!, baseline)}</span> : null}
        </span>
      </span>
    </RadioCard>
  );
}

type SummaryProps = {
  pkg: ShelfPackage | null;
  discountGroup: string | null;
  pending: boolean;
  onBuy: () => void;
  /** Said under the button: a refusal, a restated price, a lost reply. */
  notice?: ReactNode;
  className?: string;
};

/**
 * What the member is about to pay and get — the receipt they read before they leave for PayFast.
 * Rand in, minutes out, the list price and the discount when there is one, and exactly what the
 * price promise covers.
 */
export function PurchaseSummary(props: SummaryProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { pkg, discountGroup, pending, onBuy, notice, className } = props;
  return (
    <Panel role="group" aria-label={BUY_COPY.summaryLabel} data-purchase-summary="" className={cn("flex flex-col gap-4", className)}>
      <h2 className="text-base font-semibold text-text-primary">{BUY_COPY.summaryLabel}</h2>
      {pkg ? <SummaryFigures pkg={pkg} discountGroup={discountGroup} /> : <p className="text-sm text-text-secondary">{BUY_COPY.pickOne}</p>}
      {/* No success mark: this ends at PayFast, so "it worked" is the payment page appearing. */}
      <Button block size="lg" pending={pending} disabled={!pkg} onClick={onBuy}>{BUY_COPY.cta}</Button>
      {notice}
      <p className="text-xs text-text-secondary">{BUY_COPY.promise}</p>
    </Panel>
  );
}

function SummaryFigures({ pkg, discountGroup }: { pkg: ShelfPackage; discountGroup: string | null }) {
  return (
    <dl className="flex flex-col gap-2 text-sm" data-summary-package={pkg.id}>
      <SummaryRow term={BUY_COPY.youGet}>
        <span className="text-xl font-bold text-accent-strong"><Minutes value={pkg.minutes} /></span>
        <span className="block text-xs font-normal text-text-secondary">{pkg.name}</span>
      </SummaryRow>
      {pkg.discount_bps > 0 ? (
        <>
          <SummaryRow term={BUY_COPY.listPrice}>{formatMoney(pkg.list_price_zar)}</SummaryRow>
          <SummaryRow term={BUY_COPY.discountLine(discountPercent(pkg.discount_bps), discountGroup ?? "Group")}>
            {`−${formatMoney(pkg.list_price_zar - pkg.price_zar)}`}
          </SummaryRow>
        </>
      ) : null}
      <div className="border-t border-border pt-2">
        <SummaryRow term={BUY_COPY.youPay}><span className="text-lg font-bold">{formatMoney(pkg.price_zar)}</span></SummaryRow>
      </div>
    </dl>
  );
}

function SummaryRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <dt className="text-text-secondary">{term}</dt>
      <dd className="min-w-0 text-right font-semibold tabular-nums text-text-primary [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
