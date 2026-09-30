import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { renderPage, signOut, type StubRoute } from "@/test/harness";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../sheet";
import { BookSheet } from "@/components/bookings/BookSheet";
import { CancelSheet } from "@/components/bookings/CancelSheet";
import type { GridBooking, SelectedSlot } from "@/components/bookings/types";
import { AcceptSheet } from "@/components/players/invites/AcceptSheet";
import { PlayerPickerDialog } from "@/components/players/PlayerPicker";
import { ResultSheet } from "@/components/play/ResultSheet";
import { GoalSheet } from "@/components/play/GoalSheet";
import { CelebrationOverlay } from "@/components/play/CelebrationOverlay";
import { GroupSheet } from "@/components/groups/GroupSheet";
import type { ClubContext } from "@/components/groups/groupDraft";
import { CourtSheet } from "@/components/settings/CourtSheet";
import { TopUpSheet } from "@/components/members/TopUpSheet";
import { GroupAssign } from "@/components/members/GroupAssign";
import AdminWebhooksPage from "@/pages/AdminWebhooks";
import type { Invite } from "@/lib/playersApi";
import { groupFixture, restrictedGroupFixture } from "@/test/groupFixtures";
import { celebration, serve, view } from "@/components/play/__tests__/playKit";

/**
 * F4.5 — focus goes back to what opened a dialog when it closes.
 *
 * <p>
 * Radix returns focus on close only to a `DialogTrigger`, and none of these dialogs has one: each
 * opens from a grid cell, a row, a menu or a state change. Every case below opens the REAL product
 * dialog from a plain `<button>` that only sets state (or, for the mount-to-open sheets, mounts
 * them), closes it by Escape and again by the close ×, and asserts focus is back on that button —
 * never on `<body>`. The fix under test is `DialogSurface` in `ui/dialog.tsx`, which every
 * `DialogContent` and `SheetContent` renders.
 * </p>
 */

vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const MEMBER = "66666666-6666-6666-6666-666666666666";
const SLOT: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceCredits: 50 };
const MINE: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: SLOT.startsAt, endsAt: "2030-09-09T16:15:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: false, amountChargedCredits: 50, timezone: TZ,
};
const QUOTE = {
  bookingId: "bk-1", amountChargedCredits: 50, refundCredits: 50, penaltyCredits: 0, penaltyPct: 30,
  penaltyWindowMinutes: 15, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

function at(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

const INVITE = {
  participant_id: "p0000000-0000-0000-0000-000000000003", booking_id: "b0000000-0000-0000-0000-000000000001",
  status: "invited", seat: 3, team: "B", open_link: false, court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 4, share_credits: 25, to_pay_credits: 25, needs_consent: false,
  balance_credits: 120, spendable_credits: 100, held_credits: 20, balance_after_credits: 95, short_by_credits: 0,
  share_deadline: at(26.75), cap: null,
} as Invite;

const CLUB_CONTEXT: ClubContext = {
  club: { mon: [{ start: 360, end: 1320 }] },
  sliceMinutes: 15,
  courtPrices: [8],
  clubCaps: { slotCap: null, minuteCap: null, advanceDays: 14 },
  clubRate: undefined,
  blockZar: undefined,
  peakHours: undefined,
  peakAdvanceHours: undefined,
};

const PARTNERS: StubRoute[] = [
  { path: "/api/v1/me/partners/favourites", body: { items: [] } },
  { path: "/api/v1/me/partners/recent", body: { items: [] } },
];

const noop = () => undefined;

/* ─────────────────────────────── the cases ─────────────────────────────── */

/** Renders the dialog for the harness's open state; `close` is what its own "closed" callback does. */
type Draw = (open: boolean, close: () => void) => ReactNode;

type Case = {
  name: string;
  /** Routes the dialog reads (on top of the signed-in session `serve` answers). */
  routes?: StubRoute[];
  admin?: boolean;
  draw: Draw;
};

/** The sheets that take `open`/`onOpenChange`. */
const CONTROLLED: Case[] = [
  {
    name: "Book (BookSheet)",
    draw: (open, close) => (
      <BookSheet open={open} onOpenChange={(o) => { if (!o) close(); }} slots={[SLOT]} timezone={TZ} sliceMinutes={15}
        isAdmin={false} actorUserId={ME} balanceCredits={500} onBooked={noop} />
    ),
  },
  {
    name: "Cancel booking (CancelSheet)",
    routes: [{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: QUOTE }],
    draw: (open, close) => (
      <CancelSheet open={open} onOpenChange={(o) => { if (!o) close(); }} bookings={[MINE]} isAdmin={false} />
    ),
  },
  {
    name: "Accept invite (AcceptSheet)",
    draw: (open, close) => (
      <AcceptSheet invite={INVITE} open={open} onOpenChange={(o) => { if (!o) close(); }} onReread={() => Promise.resolve()} />
    ),
  },
  {
    name: "Player picker (PlayerPickerDialog)",
    routes: PARTNERS,
    draw: (open, close) => (
      <PlayerPickerDialog title="Invite a player" open={open} onOpenChange={(o) => { if (!o) close(); }} onPick={noop} excludeUserIds={[]} />
    ),
  },
  {
    name: "Record result (ResultSheet)",
    draw: (open, close) => (
      <ResultSheet open={open} onOpenChange={(o) => { if (!o) close(); }} view={view()} onDone={noop} onStale={noop} />
    ),
  },
  {
    name: "Monthly goal (GoalSheet)",
    draw: (open, close) => (
      <GoalSheet open={open} onOpenChange={(o) => { if (!o) close(); }} goalMinutes={600} onSaved={noop} />
    ),
  },
  {
    name: "Court sheet (CourtSheet, court=\"new\")",
    admin: true,
    draw: (open, close) => <CourtSheet court={open ? "new" : null} suggestedPrice={8} onClose={close} onSaved={noop} />,
  },
];

/** The sheets their callers mount to open and unmount to close. */
const MOUNTED: Case[] = [
  {
    name: "Group sheet (GroupSheet)",
    admin: true,
    draw: (open, close) => (open ? (
      <GroupSheet group={groupFixture()} tab="settings" onTab={noop} context={CLUB_CONTEXT} saving={false}
        error={null} onSave={noop} onClose={close} members={null} />
    ) : null),
  },
  {
    name: "admin Top-up (TopUpSheet)",
    admin: true,
    draw: (open, close) => (open ? (
      <TopUpSheet name="Sam" balance={200} busy={false} bookingError={null} onApply={() => Promise.resolve(null)} onClose={close} />
    ) : null),
  },
  {
    name: "Change groups (GroupAssign)",
    admin: true,
    routes: [{ path: "/api/v1/admin/member-groups", body: { groups: [groupFixture(), restrictedGroupFixture()] } }],
    draw: (open, close) => (open ? (
      <GroupAssign userId={MEMBER} name="Thandi Mokoena" current={[{ id: "g-regular", name: "Regular" }]}
        onClose={close} onSaved={noop} />
    ) : null),
  },
];

/** The two primitives every product dialog is built from. */
const PRIMITIVES: Case[] = [
  {
    name: "primitive DialogContent",
    draw: (open, close) => (
      <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent>
          <DialogTitle>Plain dialog</DialogTitle>
          <DialogDescription>Nothing but the surface.</DialogDescription>
          <button type="button">Inside</button>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    name: "primitive SheetContent",
    draw: (open, close) => (
      <Sheet open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <SheetContent>
          <SheetTitle>Plain sheet</SheetTitle>
          <SheetDescription>Nothing but the surface.</SheetDescription>
          <button type="button">Inside</button>
        </SheetContent>
      </Sheet>
    ),
  },
];

/* ─────────────────────────────── the harness ─────────────────────────────── */

/** A plain button — NOT a DialogTrigger — that only sets the state the dialog is drawn from. */
function Opener({ draw }: { draw: Draw }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {draw(open, () => setOpen(false))}
    </>
  );
}

type CloseBy = "Escape" | "the close ×";

function close(dialog: HTMLElement, by: CloseBy) {
  if (by === "Escape") {
    fireEvent.keyDown(dialog, { key: "Escape" });
    return;
  }
  // Found by its slot, not its name: ResultSheet and GoalSheet name the × after their own "Cancel".
  const x = dialog.querySelector<HTMLElement>('[data-slot="dialog-close"]');
  expect(x, "every DialogContent/SheetContent carries the close ×").not.toBeNull();
  fireEvent.click(x!);
}

/** jsdom does not focus on click, so the opener is focused first — as a real click or Enter would. */
async function openFrom(button: HTMLElement): Promise<HTMLElement> {
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog");
  // Radix has moved focus inside by now; the return below is therefore a real return.
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return dialog;
}

async function expectReturnedTo(button: HTMLElement) {
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
  expect(document.activeElement).not.toBe(document.body);
}

const BY: CloseBy[] = ["Escape", "the close ×"];
const ALL = [...CONTROLLED, ...MOUNTED, ...PRIMITIVES];

describe.each(BY)("F4.5 — closed by %s, focus goes back to the opener", (by) => {
  it.each(ALL.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    serve(c.routes ?? [], { admin: c.admin ?? false });
    renderPage(<Opener draw={c.draw} />);
    const button = screen.getByRole("button", { name: "Open" });
    const dialog = await openFrom(button);
    close(dialog, by);
    await expectReturnedTo(button);
  });

  it("New webhook (AdminWebhooks' create dialog, opened by its own button)", async () => {
    serve([{ path: "/api/v1/admin/webhooks", body: [] }], { admin: true });
    renderPage(<AdminWebhooksPage />);
    const button = screen.getByRole("button", { name: "New endpoint" });
    await waitFor(() => expect(button).not.toBeDisabled());
    const dialog = await openFrom(button);
    expect(within(dialog).getByRole("heading", { name: "New webhook endpoint" })).toBeInTheDocument();
    close(dialog, by);
    await expectReturnedTo(button);
  });

  it("Celebration (CelebrationOverlay) — it arrives on its own, so the opener is whatever had focus", async () => {
    serve([
      { path: "/api/v1/me/play/celebrations", body: { timezone: TZ, items: [celebration()] } },
      { method: "POST", path: "/api/v1/me/play/celebrations/seen", body: { seen: 1 } },
    ]);
    renderPage(<><button type="button">Where I was</button><CelebrationOverlay /></>, { initialEntries: ["/bookings"] });
    const button = screen.getByRole("button", { name: "Where I was" });
    button.focus();
    const dialog = await screen.findByRole("dialog", { name: /First win/ });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    close(dialog, by);
    await expectReturnedTo(button);
  });
});

/* ─────────────────────────────── the fallback ─────────────────────────────── */

/** The opener leaves the page while the dialog is open — a menu item, a re-rendered row. */
function VanishingOpener() {
  const [open, setOpen] = useState(false);
  const [there, setThere] = useState(true);
  return (
    <main id="main-content" tabIndex={-1}>
      {there ? <button type="button" onClick={() => setOpen(true)}>Open</button> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Row actions</DialogTitle>
          <DialogDescription>The row that opened this is about to go.</DialogDescription>
          <button type="button" onClick={() => setThere(false)}>Remove the row</button>
        </DialogContent>
      </Dialog>
    </main>
  );
}

describe("F4.5 — the opener is gone", () => {
  it.each(BY)("closed by %s, focus lands on #main-content, not <body>", async (by) => {
    renderPage(<VanishingOpener />);
    const dialog = await openFrom(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove the row" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open", hidden: true })).toBeNull());
    close(dialog, by);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("main-content")));
  });
});

/**
 * R1 (F3 follow-up) — a tap in iOS Safari focuses nothing, so `document.activeElement` is `<body>`
 * when the dialog opens. The pressed control is the opener then, ahead of `<main>`.
 */
describe("a dialog opened by a press that focused nothing", () => {
  function Tapped() {
    const [open, setOpen] = useState(false);
    return (
      <main id="main-content" tabIndex={-1}>
        <button type="button" onClick={() => setOpen(true)}><span>Tap to open</span></button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Tapped</DialogTitle>
            <DialogDescription>Opened by a tap</DialogDescription>
          </DialogContent>
        </Dialog>
      </main>
    );
  }

  it("returns focus to the pressed control, not to <main>", async () => {
    renderPage(<Tapped />);
    const button = screen.getByRole("button", { name: "Tap to open" });
    (document.activeElement as HTMLElement | null)?.blur();
    // A press on the icon INSIDE the button, and no focus — as Safari does it.
    fireEvent.pointerDown(button.querySelector("span")!);
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  });
});
