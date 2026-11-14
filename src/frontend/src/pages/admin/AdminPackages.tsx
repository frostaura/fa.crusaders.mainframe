import { useMemo, useState, type ReactNode } from "react";
import { ActionsMenu } from "../../components/admin/ActionsMenu";
import { pageHeading } from "../../lib/focusAfterAction";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { Minutes } from "../../components/Minutes";
import { useToast } from "../../components/toastContext";
import { useBoxAtLeast } from "../../components/admin/useBoxAtLeast";
import { useInlineEditorFocus } from "../../components/admin/useInlineEditorFocus";
import { PackageEditor } from "../../components/packages/PackageEditor";
import { useActiveGroups, usePackages, type GroupsRead } from "../../components/packages/usePackages";
import { StaleNotice } from "../../components/shell/StaleNotice";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Archive, HourglassMedium, Plus } from "../../components/ui/icons";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { RefreshButton } from "../../components/ui/refresh-button";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "../../components/ui/sheet";
import { Skeleton } from "../../components/ui/skeleton";
import { StateBlock } from "../../components/ui/state-block";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { useIsSmUp } from "../../components/ui/use-media-query";
import { WithAside } from "../../components/ui/with-aside";
import { adminEndpoints, type AdminPackage, type MemberGroup, type PackageStatus } from "../../lib/adminApi";
import {
  PACKAGES_COPY as COPY, PACKAGE_LIMITS, baselineOf, perHour, savingOf, shelfOrder, type ShelfItem,
} from "../../lib/packagesCopy";
import { memberShelfOf } from "../../components/packages/memberShelf";
import { cn, formatMoney } from "../../lib/utils";

/**
 * Admin · Packages (`/admin/packages`, P13 contract §3.5, §4) — what members buy minutes in.
 *
 * <p>
 * <b>Shelves, not a flat list.</b> A package is on the club's shelf (every member, at their
 * group's discount) or on one group's own; the page shows each shelf under its heading, in the
 * order the member sees it, with the sum a member does: rand per hour and what each saves
 * against the smallest (§4.3).
 * </p>
 *
 * <p>
 * <b>Every form factor uses its width.</b> From a 56rem box (a 1024 screen beside the admin rail, L6-7) the list is a table and the editor
 * stands BESIDE it (`WithAside`), so a price is changed with the shelf in view; narrower, the
 * list is cards and the editor is a sheet from the bottom.
 * </p>
 *
 * <p>
 * <b>Retired, never deleted</b> — purchase rows name a package. Retiring takes it off every
 * shelf at once; an open checkout still completes at the price it was shown (§4.4).
 * </p>
 */
export default function AdminPackagesPage() {
  const [view, setView] = useState<PackageStatus>("active");
  const read = usePackages(view);
  const groups = useActiveGroups();
  const [editing, setEditing] = useState<AdminPackage | "new" | null>(null);
  const [boxRef, roomy] = useBoxAtLeast(56);
  // R8 X8-3: the rail's editor takes focus (Name was six Tabs past every row) and Cancel or Save
  // gives it back to the Edit / Add button that opened it, not to <body>. A sheet does both itself.
  const editorRegion = useInlineEditorFocus(roomy ? editing : null, (was) =>
    document.querySelector<HTMLElement>(`[data-opens-editor="${was === "new" ? "new" : was.id}"]`));
  const toast = useToast();
  const activeCount = read.active?.length ?? 0;
  const atLimit = activeCount >= PACKAGE_LIMITS.activeMax;
  const add = () => setEditing("new");

  const saved = (pkg: AdminPackage, said: string) => {
    read.settle(pkg);
    setEditing(null);
    toast.push({ tone: "success", text: said });
    void read.load();
  };

  const editor = editing ? (
    <PackageEditor
      key={editing === "new" ? "new" : editing.id}
      pkg={editing}
      active={read.active}
      groups={groups.status === "ready" ? groups.groups : null}
      onSaved={saved}
      onCancel={() => setEditing(null)}
      inSheet={!roomy}
    />
  ) : null;

  return (
    <PageShell width="full">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={(
          <>
            <RefreshButton label={COPY.refresh} loading={read.loading} onRefresh={() => void read.load()} />
            <Button onClick={add} disabled={atLimit} data-opens-editor="new" icon={<Plus aria-hidden="true" />}>{COPY.add}</Button>
          </>
        )}
      />
      <Toolbar view={view} onView={setView} activeCount={read.active === null ? null : activeCount} />
      {atLimit ? <Alert tone="warning">{COPY.atLimit}</Alert> : null}
      {groups.status === "failed" ? <Alert tone="warning">{COPY.groupsCaveat}</Alert> : null}
      <div ref={boxRef} className="min-w-0">
        <WithAside
          aside={<EditorPanel editing={editing}><div ref={editorRegion} className="contents">{roomy ? editor : null}</div></EditorPanel>}
          asideLabel={COPY.asideLabel}
          placement="sheet"
          at="56rem"
          asideWidth="20rem"
        >
          <PackagesList view={view} read={read} groups={groups} wide={roomy} onAdd={add} onEdit={setEditing} />
        </WithAside>
      </div>
      <EditorSheet editing={roomy ? null : editing} onClose={() => setEditing(null)}>{roomy ? null : editor}</EditorSheet>
    </PageShell>
  );
}

/** The package whose Retire question is up, and whether it is still open (it stays mounted while it closes). */
type Retiring = { pkg: AdminPackage; open: boolean };

function asking(pkg: AdminPackage): Retiring {
  return { pkg, open: true };
}

function dismissed(now: Retiring | null): Retiring | null {
  if (!now) return now;
  return { pkg: now.pkg, open: false };
}

type PackagesListProps = {
  view: PackageStatus;
  read: ReturnType<typeof usePackages>;
  groups: ReturnType<typeof useActiveGroups>;
  wide: boolean;
  onAdd: () => void;
  onEdit: (pkg: AdminPackage) => void;
};

/** The shelves in their three states — loading, failed, empty — never collapsed into one. */
function PackagesList({ view, read, groups, wide, onAdd, onEdit }: PackagesListProps) {
  const active = view === "active";
  // Which package, and whether its question is open, are separate (R9 X9-1): the dialog stays
  // mounted while it closes, so Radix's close-time focus runs and Esc or Cancel lands on the ⋯.
  const [retiring, setRetiring] = useState<Retiring | null>(null);
  const ask = (pkg: AdminPackage) => setRetiring(asking(pkg));
  const dismiss = () => setRetiring(dismissed);
  return (
    <>
      <RetireDialog
        pkg={retiring?.pkg ?? null}
        open={retiring?.open ?? false}
        onClose={dismiss}
        onRetired={(p) => { read.settle(p); void read.load(); }}
      />
      <StaleNotice stale={Boolean(read.error) && read.packages !== null} readAt={read.readAt} />
      <StateBlock
        loading={read.loading && read.packages === null}
        error={read.packages === null ? read.error : null}
        action={COPY.readAction}
        failedCaveat={COPY.readCaveat}
        onRetry={() => void read.load()}
        empty={read.packages !== null && read.packages.length === 0}
        emptyTitle={active ? COPY.emptyTitle : COPY.archivedEmptyTitle}
        emptyHint={active ? COPY.emptyHint : COPY.archivedEmptyHint}
        emptyIcon={HourglassMedium}
        emptyAction={active ? <Button onClick={onAdd} icon={<Plus aria-hidden="true" />}>{COPY.add}</Button> : undefined}
        skeleton={<ListSkeleton />}
      >
        {read.packages ? (
          <Shelves packages={read.packages} groups={groups} wide={wide} onEdit={onEdit} onRetire={ask} />
        ) : null}
      </StateBlock>
    </>
  );
}

function Toolbar({ view, onView, activeCount }: { view: PackageStatus; onView: (v: PackageStatus) => void; activeCount: number | null }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ToggleGroup
        type="single"
        variant="outline"
        aria-label={COPY.viewLabel}
        value={view}
        onValueChange={(v) => { if (v) onView(v as PackageStatus); }}
      >
        <ToggleGroupItem value="active">{COPY.viewActive}</ToggleGroupItem>
        <ToggleGroupItem value="archived">{COPY.viewArchived}</ToggleGroupItem>
      </ToggleGroup>
      {activeCount === null ? null : <p className="text-sm tabular-nums text-text-secondary">{COPY.count(activeCount)}</p>}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2].map((row) => <Skeleton key={row} className="h-20 w-full" />)}
    </div>
  );
}

/** The rail beside the list: the editor, or what to do to get one. */
function EditorPanel({ editing, children }: { editing: AdminPackage | "new" | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-bg-surface p-5 shadow-xs">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-text-primary">
          {editing === null ? COPY.asideIdleTitle : editing === "new" ? COPY.addTitle : COPY.editTitle(editing.name)}
        </h2>
        <p className="text-sm text-text-secondary">
          {editing === null ? COPY.asideIdleHint : editing === "new" ? COPY.addDescription : COPY.editDescription}
        </p>
      </div>
      {children}
    </div>
  );
}

/** A phone's editor: a sheet from the bottom (a desktop's stands beside the list instead). */
function EditorSheet({ editing, onClose, children }: { editing: AdminPackage | "new" | null; onClose: () => void; children: ReactNode }) {
  const wide = useIsSmUp();
  return (
    <Sheet open={editing !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {editing !== null ? (
        <SheetContent side={wide ? "right" : "bottom"}>
          <SheetHeader>
            <SheetTitle>{editing === "new" ? COPY.addTitle : COPY.editTitle(editing.name)}</SheetTitle>
            <SheetDescription>{editing === "new" ? COPY.addDescription : COPY.editDescription}</SheetDescription>
          </SheetHeader>
          {/* The editor brings its own body and docked footer (L6-8). */}
          {children}
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

/** `member`: the shelf a member of it SEES (club packages too, at the group's discount) — what a saving is measured against (J6-5). */
type Shelf = { key: string; title: string; hint: string; packages: AdminPackage[]; member: ShelfItem[] };

/** The club's shelf first, then each group's, each in the member's order (§3.5, §4.2). */
function shelvesOf(packages: AdminPackage[], groups: GroupsRead): Shelf[] {
  const named = new Map<string, MemberGroup>(groups.status === "ready" ? groups.groups.map((g) => [g.id, g]) : []);
  const byKey = new Map<string, Shelf>();
  for (const p of packages) {
    const key = p.group?.id ?? "club";
    if (!byKey.has(key)) {
      const name = p.group ? named.get(p.group.id)?.name ?? p.group.name : null;
      byKey.set(key, name === null
        ? { key, title: COPY.clubShelf, hint: COPY.clubShelfHint, packages: [], member: [] }
        : { key, title: COPY.groupShelf(name), hint: COPY.groupShelfHint(name), packages: [], member: [] });
    }
    byKey.get(key)!.packages.push(p);
  }
  const known = groups.status === "ready" ? groups.groups : null;
  const shelves = [...byKey.values()].map((s) => ({
    ...s, packages: [...s.packages].sort(shelfOrder), member: memberShelfOf(packages, s.key === "club" ? null : s.key, known),
  }));
  return shelves.sort((a, b) => (a.key === "club" ? -1 : b.key === "club" ? 1 : a.title.localeCompare(b.title)));
}

type ShelvesProps = {
  packages: AdminPackage[]; groups: GroupsRead; wide: boolean;
  onEdit: (p: AdminPackage) => void; onRetire: (p: AdminPackage) => void;
};

function Shelves({ packages, groups, wide, onEdit, onRetire }: ShelvesProps) {
  const shelves = useMemo(() => shelvesOf(packages, groups), [packages, groups]);
  return (
    <div className="flex flex-col gap-8">
      {shelves.map((shelf) => (
        <section key={shelf.key} aria-labelledby={`shelf-${shelf.key}`} className="flex flex-col gap-3" data-shelf={shelf.key}>
          <div className="flex flex-col gap-0.5">
            <h2 id={`shelf-${shelf.key}`} className="text-sm font-semibold text-text-primary">{shelf.title}</h2>
            <p className="text-sm text-text-secondary">{shelf.hint}</p>
          </div>
          {wide
            ? <ShelfTable shelf={shelf} onEdit={onEdit} onRetire={onRetire} />
            : <ShelfCards shelf={shelf} onEdit={onEdit} onRetire={onRetire} />}
        </section>
      ))}
    </div>
  );
}

type ShelfViewProps = { shelf: Shelf; onEdit: (p: AdminPackage) => void; onRetire: (p: AdminPackage) => void };

/** "Saves R50.00 (8%)", "Smallest", or a dash — against the smallest package on a member's shelf (§4.3). */
function savingWords(p: AdminPackage, shelf: Shelf): string {
  if (p.status !== "active") return COPY.noSaving;
  const baseline = baselineOf(shelf.member);
  if (baseline && baseline.id === p.id && shelf.member.length > 1) return COPY.baseline;
  const saving = savingOf(p, baseline);
  return saving ? COPY.saves(saving.zar, saving.pct) : COPY.noSaving;
}

/**
 * The figure columns sit closer (R9 L9-5): beside the 20rem editor at 1024 and 1280 the table has
 * 608px, and at the default cell padding Actions either wrapped ⋯ under Edit or ran 40px past the
 * box. The outer columns keep the table's edge; "Per hour" wraps between its words like its cells.
 */
const FIGURE = "px-2 text-right";

function ShelfTable({ shelf, onEdit, onRetire }: ShelfViewProps) {
  const c = COPY.columns;
  return (
    <Table label={COPY.listLabel(shelf.title)}>
      <TableHeader>
        <TableRow>
          <TableHead>{c.name}</TableHead>
          <TableHead className={FIGURE}>{c.minutes}</TableHead>
          <TableHead className={FIGURE}>{c.price}</TableHead>
          <TableHead className={cn(FIGURE, "whitespace-normal")}>{c.perHour}</TableHead>
          <TableHead className={FIGURE}>{c.saves}</TableHead>
          <TableHead className={FIGURE}>{c.order}</TableHead>
          <TableHead className="text-right">{c.actions}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shelf.packages.map((p) => (
          <TableRow key={p.id} data-package-row={p.id}>
            <TableCell className="font-semibold text-text-primary">{p.name}</TableCell>
            <TableCell className={FIGURE}><Minutes value={p.minutes} /></TableCell>
            <TableCell className={cn(FIGURE, "tabular-nums")}>{formatMoney(p.price_zar)}</TableCell>
            <TableCell className={cn(FIGURE, "tabular-nums text-text-secondary")}>{formatHourly(p)}</TableCell>
            <TableCell className={cn(FIGURE, "tabular-nums")}>{savingWords(p, shelf)}</TableCell>
            <TableCell className={cn(FIGURE, "tabular-nums text-text-secondary")}>{p.sort_order}</TableCell>
            <TableCell className="text-right"><RowActions pkg={p} onEdit={onEdit} onRetire={onRetire} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function formatHourly(p: AdminPackage): string {
  const hourly = perHour(p.price_zar, p.minutes);
  return hourly === null ? COPY.noSaving : COPY.perHour(hourly);
}

/** A phone's shelf: one card per package — name and price over minutes, the rate and the saving. */
function ShelfCards({ shelf, onEdit, onRetire }: ShelfViewProps) {
  return (
    <ul aria-label={COPY.listLabel(shelf.title)} className="flex flex-col gap-3">
      {shelf.packages.map((p) => (
        <li key={p.id} data-package-row={p.id} className="flex flex-col gap-2 rounded-xl border border-border bg-bg-surface p-4 shadow-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="min-w-0 break-words font-semibold text-text-primary">{p.name}</p>
            <p className="font-semibold tabular-nums text-text-primary">{formatMoney(p.price_zar)}</p>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
            <Minutes value={p.minutes} />
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatHourly(p)}</span>
            {savingWords(p, shelf) !== COPY.noSaving ? <Badge tone="success">{savingWords(p, shelf)}</Badge> : null}
          </p>
          <RowActions pkg={p} onEdit={onEdit} onRetire={onRetire} />
        </li>
      ))}
    </ul>
  );
}

function RowActions({ pkg, onEdit, onRetire }: { pkg: AdminPackage; onEdit: (p: AdminPackage) => void; onRetire: (p: AdminPackage) => void }) {
  if (pkg.status !== "active") return <Badge tone="neutral">{COPY.retiredOn}</Badge>;
  return (
    // Never wraps (R9 L9-5): beside the 20rem editor at 1024/1280 the cell squeezed ⋯ under Edit.
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" aria-label={COPY.editLabel(pkg.name)} data-opens-editor={pkg.id} onClick={() => onEdit(pkg)}>{COPY.edit}</Button>
      {/* R8 J8-5: Retire lives behind ⋯, as Boards' Delete does (P3: the rare, destructive act is
          not beside Edit at thumb distance). The inline armed confirm ran its sentence eight lines
          deep in the ~100px Actions column at 1280; a second labelled button under Edit cost the
          column 88px on a touch screen and ran the shelf table past its column (admin-r6 L6-7). */}
      <ActionsMenu label={`${COPY.columns.actions} for ${pkg.name}`} items={[{
        label: COPY.retire, icon: <Archive size={16} aria-hidden="true" />, danger: true, onSelect: () => onRetire(pkg),
      }]} />
    </div>
  );
}

/** The ⋯ of a package's row — where a dismissed Retire question hands focus back. */
const rowMenuOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-package-row="${CSS.escape(id)}"] button[aria-haspopup="menu"]`);

/**
 * The retire question, asked by the LIST, not the row (R8 J8-5): the row leaves the shelf when it
 * is retired, and a dialog mounted in it went with it — its close-time focus never ran and focus
 * fell to <body>. Here it survives the row and floors focus on the page heading.
 *
 * <p>
 * R9 X9-1: dismissed (Esc, Cancel, ×), the row is still there, and focus goes back to its ⋯. The
 * dialog was unmounted the moment it closed, so the return never ran and focus fell to <main>.
 * </p>
 */
function RetireDialog({ pkg, open, onClose, onRetired }: {
  pkg: AdminPackage | null; open: boolean; onClose: () => void; onRetired: (p: AdminPackage) => void;
}) {
  const toast = useToast();
  if (!pkg) return null;
  return (
    <ConfirmDialog
      key={pkg.id}
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      returnFocus={() => rowMenuOf(pkg.id)}
      focusAfter={pageHeading}
      title={COPY.retireLabel(pkg.name)}
      description={COPY.retireConfirm(pkg.name)}
      confirmLabel={COPY.retire}
      cancelLabel={COPY.cancel}
      action={COPY.retireAction}
      codes={COPY.errorCodes}
      // FA-11: a lost reply is read back from the club's packages (Retire is idempotent on the
      // API), so a retire that landed is said as landed rather than as a failure.
      describe={(e) => unsureSentence(e, unsureWords(`${pkg.name} is still on sale`, `${pkg.name} was retired`, "Packages"))}
      onConfirm={async () => {
        const { value: retired, proven, answered } = await writeOrReadBack(
          () => adminEndpoints.packageArchive(pkg.id),
          async () => (await adminEndpoints.packages("all")).packages.find((p) => p.id === pkg.id && p.status === "archived") ?? null,
        );
        onRetired(retired);
        const done = COPY.retired(pkg.name);
        toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(done, answered) : done });
      }}
    />
  );
}
