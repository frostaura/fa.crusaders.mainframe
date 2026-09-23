import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";
import {
  doorsAttentionLabel, faultsAttentionLabel, pendingApplicationsLabel, useAdminAttention,
  type AdminAttention, type AttentionSource,
} from "@/lib/adminAttention";
import { Alert } from "@/components/Alert";
import { AttentionCount, attentionName } from "@/components/admin/AdminRail";
import { ADMIN_NAV, ADMIN_NAV_ITEMS, PENDING_APPLICATIONS_HREF, type AdminNavItem } from "@/components/admin/adminNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, CaretRight, CheckCircle, SealCheck, WarningCircle } from "@/components/ui/icons";
import { Interactable } from "@/components/ui/interactable";
import { PageHeader, PageShell, Section } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/admin` — the console's Overview: what needs an admin right now, then every section of the
 * console with a line on what it is for (plan: Target IA → Admin, "Needs attention").
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

const CARD = "flex min-h-40 flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4 text-left shadow-xs sm:p-5";

type AttentionCardProps = {
  item: AdminNavItem;
  href: string;
  count: number;
  failed: boolean;
  tone: CardTone;
  copy: { title: string; clear: string; cta: string; detail?: ReactNode };
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
        <ItemIcon size={16} weight="bold" />
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
function ClearCard({ item, sentence }: { item: AdminNavItem; sentence: string }) {
  return (
    <div data-attention-card={item.id} data-state="clear" className={cn(CARD, "shadow-none")}>
      <CardEyebrow item={item} tone="muted" />
      <p className="mt-auto flex items-center gap-2 text-sm font-medium text-text-secondary">
        <CheckCircle size={20} weight="fill" aria-hidden="true" className="shrink-0 text-success-strong" />
        <span>{sentence}</span>
      </p>
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
        <span id={titleId} className="flex items-baseline gap-2">
          <span className={cn(typography({ variant: "display" }), "leading-none")}>{count}</span>
          {/* A real space BETWEEN the two, not inside the second: name computation trims a
              child's own leading space, and the name became "2doors need attention". */}
          {" "}
          <span className="text-sm font-semibold text-text-primary">{withoutCount(copy.title)}</span>
        </span>
        {copy.detail ? <span id={detailId} className="text-sm text-text-secondary">{copy.detail}</span> : null}
        <span aria-hidden="true" className="mt-auto inline-flex items-center gap-1 text-sm font-semibold text-accent-strong">
          {copy.cta}
          <ArrowRight size={16} weight="bold" />
        </span>
      </Link>
    </Interactable>
  );
}

function AttentionCard(props: AttentionCardProps) {
  if (props.failed) return <FailedCard item={props.item} />;
  if (props.count <= 0) return <ClearCard item={props.item} sentence={props.copy.clear} />;
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
    <div className="grid gap-4 md:grid-cols-3">
      <AttentionCard
        item={itemById("members")}
        href={PENDING_APPLICATIONS_HREF}
        count={attention.pending}
        failed={failed.has("pending")}
        tone="info"
        copy={{
          title: pendingApplicationsLabel(attention.pending),
          clear: "No applications waiting.",
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
          clear: "Every door is reporting.",
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
          cta: "Open Faults",
          detail: <FaultBreakdown counts={attention.faultCounts} />,
        }}
      />
    </div>
  );
}

function AttentionSkeleton() {
  return (
    <div data-attention-loading="" aria-busy="true">
      <p role="status" className="sr-only">Checking what needs attention…</p>
      <div className="grid gap-4 md:grid-cols-3">
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
      </div>
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
    <li className="flex">
      <Interactable asChild surface="card" watermark>
        <Link
          to={item.path}
          data-quick-link={item.id}
          // The label and its count as one phrase; the description stays a description.
          aria-label={attentionName(item, attention)}
          aria-describedby={`${item.id}-quick-description`}
          className="flex w-full items-start gap-3 rounded-xl border border-border bg-bg-surface p-4 shadow-xs hover:border-control hover:shadow-md"
        >
          <span aria-hidden="true" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
            <ItemIcon size={20} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="min-w-0 truncate font-semibold text-text-primary">{item.label}</span>
              <AttentionCount item={item} counts={attention} />
            </span>
            <span id={`${item.id}-quick-description`} className="text-sm text-text-secondary">{item.description}</span>
          </span>
          <CaretRight size={16} weight="bold" aria-hidden="true" className="mt-1 shrink-0 text-text-muted" />
        </Link>
      </Interactable>
    </li>
  );
}

function QuickLinks({ attention }: { attention: AdminAttention }) {
  return (
    <div className="flex flex-col gap-6">
      {ADMIN_NAV.filter((group) => group.id !== "overview").map((group) => (
        <QuickLinkGroup key={group.id} label={group.label}>
          {group.items.map((item) => <QuickLink key={item.id} item={item} attention={attention} />)}
        </QuickLinkGroup>
      ))}
    </div>
  );
}

function QuickLinkGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <h3 id={id} className={typography({ variant: "overline" })}>{label}</h3>
      <ul aria-labelledby={id} className="grid gap-3 sm:grid-cols-2">{children}</ul>
    </div>
  );
}

// --- the page ---------------------------------------------------------------------------

export default function AdminHome() {
  const attention = useAdminAttention();
  return (
    <PageShell width="wide">
      {/* No eyebrow: the rail (desktop) and the section bar (phone) already say "Admin". */}
      <PageHeader
        title="Overview"
        description="What needs you right now, and every part of the club’s console."
        actions={<RefreshButton label="Refresh overview" onRefresh={() => void attention.refresh()} loading={attention.refreshing} />}
        freshness={<Freshness at={attention.checkedAt} />}
      />
      <Section title="Needs attention">
        <NeedsAttention attention={attention} />
      </Section>
      <Section title="Console" description="Every section, and what it is for.">
        <QuickLinks attention={attention} />
      </Section>
    </PageShell>
  );
}
