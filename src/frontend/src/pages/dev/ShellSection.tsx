import { useState } from "react";
import { ActionBar, ActionBarItem } from "@/components/ui/action-bar";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Plus } from "@/components/ui/icons";
import { PageHeader, Section } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { Demo, ThemePair } from "./parts";

/**
 * The page shell's parts: PageHeader in its variants (with RefreshButton + Freshness in the
 * actions slot, where refresh always lives), a Section, and the floating multiselect ActionBar.
 * Each PageHeader here renders a real `<h1>` — it is the page's only h1 in the product, and a
 * gallery of headers is the one place several stand side by side.
 */
const FAKE_READ_MS = 900;

function useFakeRead(ageMs: number) {
  const [readAt, setReadAt] = useState(() => Date.now() - ageMs);
  const [loading, setLoading] = useState(false);
  const refresh = () => {
    setLoading(true);
    window.setTimeout(() => {
      setLoading(false);
      setReadAt(Date.now());
    }, FAKE_READ_MS);
  };
  return { readAt, loading, refresh };
}

function RefreshingHeader({ ageMs, title }: { ageMs: number; title: string }) {
  const read = useFakeRead(ageMs);
  return (
    <PageHeader
      title={title}
      description="Refresh is an icon button on the right; freshness sits beside it and turns warning after a minute."
      actions={<RefreshButton onRefresh={read.refresh} loading={read.loading} />}
      freshness={<Freshness at={read.readAt} />}
    />
  );
}

function Headers() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Wallet" description="The plain header: a title and a line of description." />
      <PageHeader
        title="Nomsa Khumalo"
        eyebrow="Admin · People"
        back={{ to: "?section=shell", label: "Members" }}
        actions={<IconButton label="Add a note" variant="outline"><Plus /></IconButton>}
      />
      <RefreshingHeader title="Control board" ageMs={12_000} />
      <RefreshingHeader title="Faults" ageMs={95_000} />
      <Section title="Tonight" description="A Section: an h2, a description and right-aligned actions." actions={<Button variant="outline" size="sm">Export</Button>}>
        <p className="text-sm text-text-primary">Section content sits 16px under its heading.</p>
      </Section>
    </div>
  );
}

function ActionBarDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>Show the action bar</Button>
      </div>
      {open ? (
        <ActionBar count={3} detail="Tue 23 Sep · 18:00–19:30 · 3 courts" onClose={() => setOpen(false)}>
          <ActionBarItem asChild>
            <Button variant="ghost" size="sm">Details</Button>
          </ActionBarItem>
          <ActionBarItem asChild>
            <Button size="sm">Book · 24 cr</Button>
          </ActionBarItem>
        </ActionBar>
      ) : null}
    </div>
  );
}

export function ShellSection() {
  return (
    <div className="flex flex-col gap-10">
      <Demo title="Page header" note="The one h1 on a page, the actions slot on the right, freshness beside it.">
        <ThemePair>{() => <Headers />}</ThemePair>
      </Demo>
      <Demo title="Action bar" note="Floats above the tab bar on a phone and centres at 640px on a desktop. Escape or the cross clears it.">
        <ActionBarDemo />
      </Demo>
    </div>
  );
}
