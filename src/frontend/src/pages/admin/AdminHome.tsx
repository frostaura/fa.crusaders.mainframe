import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";
import {
  doorsAttentionLabel, faultsAttentionLabel, pendingApplicationsLabel, useAdminAttention,
  type AdminAttention, type AttentionSource,
} from "@/lib/adminAttention";
import { Alert } from "@/components/Alert";
import { AttentionCount } from "@/components/admin/AdminRail";
import { attentionName } from "@/components/admin/attentionName";
import { ADMIN_NAV, ADMIN_NAV_ITEMS, PENDING_APPLICATIONS_HREF, type AdminNavItem } from "@/components/admin/adminNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, CaretDown, CaretRight, CheckCircle, SealCheck, WarningCircle } from "@/components/ui/icons";
import { AutoGrid } from "@/components/ui/auto-grid";
import { Interactable } from "@/components/ui/interactable";
import { WithAside } from "@/components/ui/with-aside";
import { PageHeader, PageShell, Section } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { RecentAlerts } from "@/components/notifications/RecentAlerts";
import { useRecentAlerts } from "@/components/notifications/useRecentAlerts";
import {
  CONSOLE_COPY, EMAIL_ALERTS_COPY, EMAIL_ALERTS_HREF, RECENT_ALERTS_COPY, RECENT_ALERTS_SHOWN,
} from "@/lib/notificationsCopy";
import { TextLink } from "@/components/ui/text-link";

/**
 * `/admin` — the console's Overview: what needs an admin right now, what every admin was recently
 * emailed about (R23, "Recent alerts"), then every section of the console with a line on what it
 * is for (plan: Target IA → Admin, "Needs attention").
 *
 * <p>
 * <b>Four honest states, in this order</b> (the StateBlock precedence): still reading → a skeleton
 * shaped like the three cards; a read FAILED → a danger alert with Try again, and the card for that
 * source says it could not be read — never "All clear", because an empty collection on a failed
 * read is not an answer; everything read and nothing waiting → "All clear"; otherwise the three
 * cards, the ones needing somebody as links to where they are dealt with.
 * </p>
 *
 * <p>
 * The counts are the same ones the rail's badges and the app's Admin tab show — one store
 * (`lib/adminAttention.ts`) — so this page cannot say 2 beside a badge that says 3.
 * </p>
 */

const SOURCE_NAMES: Record<AttentionSource, string> = {
  pending: "the membership applications",
  doors: "the doors",
  faults: "the hardware faults",
};

function itemById(id: string): AdminNavItem {
  const item = ADMIN_NAV_ITEMS.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`adminNav has no item "${id}"`);
  return item;
}

/** "2 doors need attention" → "doors need attention": the figure is drawn large beside it. */
function withoutCount(sentence: string): string {
  return sentence.replace(/^\d+\s+/, "");
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// --- the attention cards ---------------------------------------------------------------

type CardTone = "info" | "warning";

const TONE_CHIP: Record<CardTone, string> = {
  info: "bg-info-soft text-info-strong",
  warning: "bg-warning-soft text-warning-strong",
};

/** No height floor on a phone (R4 form factor): three 160px boxes pushed everything else down. */
const CARD = "flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4 text-left shadow-xs sm:min-h-40 sm:p-5";

type AttentionCardProps = {
  item: AdminNavItem;
  href: string;
  count: number;
  failed: boolean;
  tone: CardTone;
  copy: { title: string; clear: string; clearHint?: string; cta: string; detail?: ReactNode };
};

function CardEyebrow({ item, tone }: { item: AdminNavItem; tone: CardTone | "muted" }) {
  const ItemIcon = item.icon;
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-lg",
          tone === "muted" ? "bg-bg-muted text-text-secondary" : TONE_CHIP[tone],
        )}
      >
        {/* R7 L6-16 (FD1 ask): rem-sized, so the glyph grows with the text in its rem tile. */}
        <ItemIcon size="1rem" weight="bold" />
      </span>
      <span className={typography({ variant: "overline" })}>{item.label}</span>
    </span>
  );
}

/** A source that could not be read: says so, and says what that does NOT mean. */
function FailedCard({ item }: { item: AdminNavItem }) {
  return (
    <div data-attention-card={item.id} data-state="failed" className={CARD}>
      <CardEyebrow item={item} tone="muted" />
      <p className="mt-auto flex items-start gap-2 text-sm font-medium text-danger-strong">
        <WarningCircle size={20} weight="bold" aria-hidden="true" className="shrink-0" />
        <span>Couldn’t read this. That doesn’t mean nothing is waiting.</span>
      </p>
    </div>
  );
}

/** A source that was read and has nothing waiting. Not a link: there is nothing to go and do. */
function ClearCard({ item, sentence, hint }: { item: AdminNavItem; sentence: string; hint?: string }) {
  // The answer sits under the eyebrow, where the other cards put their figure, and says what
  // would change it (VIS F3-15: beside two busy cards the Doors card was an empty box with one
  // line at its foot).
  return (
    <div data-attention-card={item.id} data-state="clear" className={cn(CARD, "shadow-none")}>
      <CardEyebrow item={item} tone="muted" />
      <p className="flex items-center gap-2 text-base font-semibold text-text-primary">
        <CheckCircle size={24} weight="fill" aria-hidden="true" className="shrink-0 text-success-strong" />
        <span>{sentence}</span>
      </p>
      {hint ? <p className="text-sm text-text-secondary">{hint}</p> : null}
    </div>
  );
}

/**
 * Something is waiting: the whole card is ONE link to where it is dealt with, carrying the
 * fingerprint (an interactive card). Its name is the sentence, its description the detail — not
 * the whole card read out as one run of text.
 */
function WaitingCard(props: AttentionCardProps) {
  const { item, href, count, tone, copy } = props;
  const titleId = useId();
  const detailId = useId();
  return (
    <Interactable asChild surface="card" watermark>
      <Link
        to={href}
        data-attention-card={item.id}
        data-state="waiting"
        aria-labelledby={titleId}
        aria-describedby={copy.detail ? detailId : undefined}
        className={cn(CARD, "hover:border-control hover:shadow-md")}
      >
        <CardEyebrow item={item} tone={tone} />
        {/* The big figure and the words after it are ONE name — "2 doors need attention" — so the
            sentence is not printed a second time beside its own number. */}
        {/* R7 L7-8: the words WRAP under a wide count rather than squeeze beside it — at 320 / 200 %
            "34" left "attention" 118px and it ran out of the card. */}
        <span id={titleId} className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn(typography({ variant: "display" }), "leading-none")}>{count}</span>
          {/* A real space BETWEEN the two, not inside the second: name computation trims a
              child's own leading space, and the name became "2doors need attention". */}
          {" "}
          <span className="min-w-0 text-sm font-semibold text-text-primary">{withoutCount(copy.title)}</span>
        </span>
        {copy.detail ? <span id={detailId} className="text-sm text-text-secondary">{copy.detail}</span> : null}
        <span aria-hidden="true" className="mt-auto inline-flex items-center gap-1 text-sm font-semibold text-accent-strong">
          {copy.cta}
          <ArrowRight size="1rem" weight="bold" className="shrink-0" />
        </span>
      </Link>
    </Interactable>
  );
}

function AttentionCard(props: AttentionCardProps) {
  if (props.failed) return <FailedCard item={props.item} />;
  if (props.count <= 0) return <ClearCard item={props.item} sentence={props.copy.clear} hint={props.copy.clearHint} />;
  return <WaitingCard {...props} />;
}

/** The door sentences, most urgent first: three at most, then a count of the rest. */
function DoorReasons({ reasons }: { reasons: readonly string[] }) {
  const shown = reasons.slice(0, 3);
  const rest = reasons.length - shown.length;
  return (
    <span className="flex flex-col gap-1">
      {shown.map((reason) => <span key={reason} className="line-clamp-2">{reason}</span>)}
      {rest > 0 ? <span className="text-text-muted">{`and ${rest} more`}</span> : null}
    </span>
  );
}

/** Critical / error / warning, as pills — the words carry it, the tone repeats it. */
function FaultBreakdown({ counts }: { counts: AdminAttention["faultCounts"] }) {
  const rows = [
    { key: "critical", label: "critical", count: counts.critical ?? 0, tone: "danger" as const },
    { key: "error", label: "error", count: counts.error ?? 0, tone: "danger" as const },
    { key: "warning", label: "warning", count: counts.warning ?? 0, tone: "warning" as const },
  ].filter((row) => row.count > 0);
  return (
    <span className="flex flex-wrap gap-1.5">
      {rows.map((row) => <Badge key={row.key} tone={row.tone}>{`${row.count} ${row.label}`}</Badge>)}
    </span>
  );
}

function AttentionGrid({ attention }: { attention: AdminAttention }) {
  const failed = new Set(attention.failed);
  return (
    // Sized by the box (R4 form factor): beside the alerts rail, inside the rail-less 1024 frame and
    // at 200 % text alike — `md:grid-cols-3` was the viewport's answer, wrong beside the rail.
    <AutoGrid min="card" max={3} gap="lg">
      <AttentionCard
        item={itemById("members")}
        href={PENDING_APPLICATIONS_HREF}
        count={attention.pending}
        failed={failed.has("pending")}
        tone="info"
        copy={{
          title: pendingApplicationsLabel(attention.pending),
          clear: "No applications waiting.",
          clearHint: "A new application shows here the moment it arrives.",
          cta: "Review applications",
          detail: "New members can’t book until an admin approves them.",
        }}
      />
      <AttentionCard
        item={itemById("doors")}
        href="/admin/monitoring/doors"
        count={attention.doors}
        failed={failed.has("doors")}
        tone="warning"
        copy={{
          title: doorsAttentionLabel(attention.doors),
          clear: attention.doorsTotal === 0 ? "No doors set up yet." : "Every door is reporting.",
          clearHint: attention.doorsTotal === 0
            ? "A door appears here once its board is added under Boards and given a door name."
            : "A door that stops calling in, or refuses members, shows here.",
          cta: "Open Doors",
          detail: <DoorReasons reasons={attention.doorReasons} />,
        }}
      />
      <AttentionCard
        item={itemById("faults")}
        href="/admin/monitoring/faults"
        count={attention.faults}
        failed={failed.has("faults")}
        tone="warning"
        copy={{
          title: faultsAttentionLabel(attention.faults),
          clear: "No faults need attention.",
          clearHint: "A board that reports a fault shows here until someone resolves it.",
          cta: "Open Faults",
          detail: <FaultBreakdown counts={attention.faultCounts} />,
        }}
      />
    </AutoGrid>
  );
}

function AttentionSkeleton() {
  return (
    <div data-attention-loading="" aria-busy="true">
      <p role="status" className="sr-only">Checking what needs attention…</p>
      <AutoGrid min="card" max={3} gap="lg">
        {[0, 1, 2].map((key) => (
          <div key={key} className={cn(CARD, "shadow-none")} aria-hidden="true">
            <span className="flex items-center gap-2">
              <Skeleton className="size-8" />
              <Skeleton className="h-3 w-20" />
            </span>
            <Skeleton className="h-9 w-16" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </AutoGrid>
    </div>
  );
}

function AllClear() {
  return (
    <div
      data-attention-clear=""
      className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-bg-surface px-6 py-10 text-center shadow-xs"
    >
      <span aria-hidden="true" className="inline-flex size-20 items-center justify-center rounded-full bg-success-soft text-success-strong">
        <SealCheck size={48} weight="duotone" />
      </span>
      <p className={typography({ variant: "h3" })}>All clear</p>
      <p className="max-w-prose text-sm text-text-secondary">
        No applications are waiting, every door is reporting, and no faults need attention.
      </p>
    </div>
  );
}

/** Which reads failed, in words, with the retry — above the cards, never instead of them. */
function FailedReads({ attention }: { attention: AdminAttention }) {
  const names = joinNames(attention.failed.map((source) => SOURCE_NAMES[source]));
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert tone="danger" className="w-full">
        {`Couldn’t read ${names}. What is shown for ${attention.failed.length === 1 ? "it" : "them"} may be out of date or missing — it doesn’t mean all is well.`}
      </Alert>
      <Button variant="outline" pending={attention.refreshing} onClick={() => void attention.refresh()}>
        Try again
      </Button>
    </div>
  );
}

function NeedsAttention({ attention }: { attention: AdminAttention }) {
  if (attention.loading) return <AttentionSkeleton />;
  const failed = attention.failed.length > 0;
  if (!failed && attention.total === 0) return <AllClear />;
  return (
    <div className="flex flex-col gap-4">
      {failed ? <FailedReads attention={attention} /> : null}
      <AttentionGrid attention={attention} />
    </div>
  );
}

// --- the quick links --------------------------------------------------------------------

function QuickLink({ item, attention }: { item: AdminNavItem; attention: AdminAttention }) {
  const ItemIcon = item.icon;
  return (
    <li className="flex min-w-0 [container-type:inline-size]">
      <Interactable asChild surface="card" watermark>
        <Link
          to={item.path}
          data-quick-link={item.id}
          // The label and its count as one phrase; the description stays a description.
          aria-label={attentionName(item, attention)}
          aria-describedby={`${item.id}-quick-description`}
          className="flex w-full items-start gap-3 rounded-xl border border-border bg-bg-surface p-4 shadow-xs hover:border-control hover:shadow-md"
        >
          {/* The tile is the 20px icon plus padding, not a rem box (R4 X4-6): `size-10` became 80px
              at 200% text and squeezed the label and description into a word-wide column. */}
          {/* And at large text it goes: a rem container query is a large-text query — 16rem is 256px
              at normal text (every card keeps its tile) and 512px at 200% ("Transactions" broke). */}
          <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center rounded-lg bg-accent-soft p-2.5 text-accent-strong [@container(max-width:16rem)]:hidden">
            <ItemIcon size={20} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="min-w-0 break-words font-semibold text-text-primary">{item.label}</span>
              <AttentionCount item={item} counts={attention} />
            </span>
            <span id={`${item.id}-quick-description`} className="text-sm text-text-secondary">{item.description}</span>
          </span>
          <CaretRight size="1rem" weight="bold" aria-hidden="true" className="mt-1 shrink-0 text-text-muted" />
        </Link>
      </Interactable>
    </li>
  );
}

/**
 * Every section, as cards. On a phone (a box under 48rem) the list repeats the section switcher at
 * the top of the screen — 1,752px of it at 390 (R5 A5-6) — so there it is folded behind one toggle;
 * from 48rem the toggle goes and the list is always open. Measured by the box, so it holds beside
 * the rail and at 200 % text alike.
 */
function QuickLinks({ attention }: { attention: AdminAttention }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="flex flex-col gap-4 [container-type:inline-size]">
      <Button
        variant="outline"
        className="self-start whitespace-normal [@container(min-width:48rem)]:hidden"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((was) => !was)}
        icon={<CaretDown aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")} />}
      >
        {open ? CONSOLE_COPY.hide : CONSOLE_COPY.show}
      </Button>
      <div
        id={listId}
        data-folded={open ? "false" : "true"}
        className={cn("flex-col gap-6 [@container(min-width:48rem)]:flex", open ? "flex" : "hidden")}
      >
        {ADMIN_NAV.filter((group) => group.id !== "overview").map((group) => (
          <QuickLinkGroup key={group.id} label={group.label}>
            {group.items.map((item) => <QuickLink key={item.id} item={item} attention={attention} />)}
          </QuickLinkGroup>
        ))}
      </div>
    </div>
  );
}

function QuickLinkGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <h3 id={id} className={typography({ variant: "overline" })}>{label}</h3>
      {/* `grid-cols-1` is minmax(0, 1fr): an implicit column is floored at its longest word, and
          at 200% text on a phone that pushed every card past the screen (R3 X-4). */}
      {/* AutoGrid's tiles are `min(100%, 18rem)`, never an implicit column, so 200 % text on a
          phone still gets one column that fits (R3 X-4). Three across where the box holds them. */}
      <AutoGrid as="ul" min="card" max={3} aria-labelledby={id}>{children}</AutoGrid>
    </div>
  );
}

// --- the page ---------------------------------------------------------------------------

export default function AdminHome() {
  const attention = useAdminAttention();
  // R23: what every admin was emailed about. Refreshed with the rest of the page, never polled.
  const alerts = useRecentAlerts();
  return (
    <PageShell width="full">
      {/* No eyebrow: the rail (desktop) and the section bar (phone) already say "Admin". */}
      <PageHeader
        title="Overview"
        description="What needs you right now, and every part of the club’s console."
        actions={(
          <RefreshButton
            label="Refresh overview"
            onRefresh={() => { void attention.refresh(); alerts.retry(); }}
            loading={attention.refreshing}
          />
        )}
        freshness={<Freshness at={attention.checkedAt} />}
      />
      {/* R4 form factor (SPEC §3.10): from a 64rem box the alerts are a rail beside the work —
          sticky, scrolling on their own — instead of a 1,000px list between the attention cards and
          the console. Narrower, they follow the attention cards as before. */}
      <WithAside
        at="64rem"
        asideWidth="24rem"
        asideLabel={RECENT_ALERTS_COPY.title}
        aside={(
          <Section title={RECENT_ALERTS_COPY.title} description={RECENT_ALERTS_COPY.description}>
            <RecentAlerts feed={alerts} shown={RECENT_ALERTS_SHOWN} />
            {/* F3.11: the switches lived only in Profile as far as anyone could find them. */}
            <TextLink variant="standalone" to={EMAIL_ALERTS_HREF} className="self-start text-sm">
              {EMAIL_ALERTS_COPY.chooseLink}
            </TextLink>
          </Section>
        )}
      >
        <Section title="Needs attention">
          <NeedsAttention attention={attention} />
        </Section>
        <Section title="Console" description="Every section, and what it is for.">
          <QuickLinks attention={attention} />
        </Section>
      </WithAside>
    </PageShell>
  );
}
