import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AutoGrid, Columns } from "@/components/ui/auto-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextBar } from "@/components/ui/context-bar";
import { SplitView } from "@/components/ui/split-view";
import { StateBlock } from "@/components/ui/state-block";
import { WithAside } from "@/components/ui/with-aside";
import { cn } from "@/lib/utils";
import { Demo } from "./parts";

/**
 * The R4 layout primitives (SPEC 2): AutoGrid and Columns, WithAside, SplitView and ContextBar.
 *
 * <p>
 * Unlike the other sections these are not shown in a light/dark pair: they are about the WIDTH
 * they are given, so each gets the whole column. The page theme (`?theme=dark`) paints them dark,
 * and `e2e/layout-primitives.spec.ts` measures them at 390/768/1024/1280/1920 and runs axe in both
 * themes. The split view's selection is `?row=` on this page, as a real screen's is a route.
 * </p>
 */
const TILE = "flex min-h-touch flex-col justify-center rounded-xl border border-border bg-bg-surface p-4 shadow-xs";

const STATS: ReadonlyArray<[string, string]> = [
  ["Games", "42"], ["Wins", "27"], ["Win rate", "64%"], ["Streak", "6 wk"], ["Courts", "4"], ["Hours", "31"],
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <li className={TILE}>
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <span className="font-display text-2xl font-bold tabular-nums">{value}</span>
    </li>
  );
}

const CARDS = ["Court 1 · 18:00", "Court 3 · 19:30", "Court 2 · Sat 09:00", "Court 4 · Sun 10:15", "Court 1 · Mon 07:00"];

function Grids() {
  return (
    <div className="flex flex-col gap-6">
      <Demo title="AutoGrid · stat, at most 6" note="One row of six beside a wide box, two across on a phone, never a word squeezed.">
        <AutoGrid as="ul" min="stat" max={6} aria-label="Stat tiles" data-demo="autogrid-stat">
          {STATS.map(([label, value]) => <Stat key={label} label={label} value={value} />)}
        </AutoGrid>
      </Demo>
      <Demo title="AutoGrid · card, at most 3">
        <AutoGrid as="ul" min="card" max={3} aria-label="Game cards" data-demo="autogrid-card">
          {CARDS.map((card) => (
            <li key={card} className={TILE}>
              <span className="text-sm font-semibold">{card}</span>
              <span className="text-xs text-text-secondary">Doubles · 2 seats open</span>
            </li>
          ))}
        </AutoGrid>
      </Demo>
      <Demo title="Columns · panel, at most 3" note="Unequal cards flow down each column; the reading order is the DOM order.">
        <Columns min="panel" max={3} data-demo="columns">
          {["Your details", "Password", "Passkeys", "Devices", "Privacy", "Email alerts"].map((title, i) => (
            <section key={title} aria-label={title} className={cn(TILE, "justify-start gap-2")}>
              <h4 className="text-sm font-semibold">{title}</h4>
              <p className="text-sm text-text-secondary">{"A setting that matters to somebody. ".repeat(1 + (i % 3))}</p>
            </section>
          ))}
        </Columns>
      </Demo>
    </div>
  );
}

function Aside() {
  return (
    <Demo title="WithAside" note="Beside the main column once the BOX is 72rem wide; stacked after it below that.">
      <WithAside asideLabel="Day summary" aside={
        <div className={cn(TILE, "gap-2")} data-demo="aside-card">
          <h4 className="text-sm font-semibold">Today</h4>
          <p className="text-sm text-text-secondary">2 bookings · 1 h 30 min · 1 more slot today</p>
          <Button size="sm">Book</Button>
        </div>
      }>
        <ContextBar position="top" label="Day" bleed={false} summary="Tue 23 Sep" actions={<Button variant="outline" size="sm">Today</Button>} />
        <div className={cn(TILE, "min-h-48")} data-demo="aside-main">
          <p className="text-sm text-text-secondary">The main column: a booking grid, a ledger, the players.</p>
        </div>
      </WithAside>
    </Demo>
  );
}

const ROWS = ["Nomsa Khumalo", "Pieter van Wyk", "Ayanda Dlamini", "Sarah Naidoo"];

function Split() {
  const [params] = useSearchParams();
  const raw = params.get("row");
  const picked = raw === null ? null : Number(raw);
  const href = (row: number | null) => {
    const next = new URLSearchParams(params);
    if (row === null) next.delete("row"); else next.set("row", String(row));
    return `?${next.toString()}`;
  };
  const list = (
    <ul className="flex flex-col gap-1">
      {ROWS.map((name, i) => (
        <li key={name}>
          <Link
            to={href(i)}
            replace
            data-split-item=""
            aria-current={picked === i ? "page" : undefined}
            className="no-lift flex min-h-touch items-center justify-between gap-2 rounded-lg px-3 text-sm font-medium hover:bg-bg-muted aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-strong"
          >
            <span className="min-w-0 break-words">{name}</span>
            <Badge tone={i % 2 ? "neutral" : "info"}>{i % 2 ? "Read" : "New"}</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
  const detail = picked === null || !ROWS[picked] ? null : (
    <div className={cn(TILE, "gap-3")} data-demo="split-detail">
      <Link to={href(null)} replace className="self-start text-sm font-semibold text-accent-strong underline-offset-2 hover:underline">Back to the list</Link>
      <h4 className="text-lg font-semibold">{ROWS[picked]}</h4>
      <p className="text-sm text-text-secondary">The detail pane scrolls with the page; the list keeps its own scroll.</p>
    </div>
  );
  return (
    <Demo title="SplitView" note="Split once the BOX is 64rem; stacked below it — the list, or the picked row with a way back.">
      <SplitView
        listLabel="People"
        list={list}
        detail={detail}
        placeholder={<StateBlock empty emptyTitle="Pick a person" emptyHint="Their record opens here." />}
      />
    </Demo>
  );
}

function DockDemo() {
  const [open, setOpen] = useState(false);
  return (
    <Demo title="ContextBar · bottom" note="One primary verb, docked above the tab bar within thumb reach; the page's padding grows by it.">
      <div>
        <Button variant="outline" onClick={() => setOpen((was) => !was)}>{open ? "Hide the docked bar" : "Show the docked bar"}</Button>
      </div>
      {open ? (
        <ContextBar position="bottom" label="Wallet actions" summary={<span className="font-semibold tabular-nums">2 h 15 min</span>} primary={<Button>Buy minutes</Button>} />
      ) : null}
    </Demo>
  );
}

export function LayoutSection() {
  return (
    <div className="flex flex-col gap-10" data-layout-demo="">
      <Grids />
      <Aside />
      <Split />
      <DockDemo />
    </div>
  );
}
