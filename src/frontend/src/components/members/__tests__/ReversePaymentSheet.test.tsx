import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ReversePaymentSheet } from "../ReversePaymentSheet";
import { refuse, renderPage, stubFetch, type StubRoute } from "../../../test/harness";
import { REVERSAL_COPY as COPY, REVERSAL_LOST } from "../../../lib/reversalCopy";
import type { ReversibleEntry } from "../../../lib/adminApi";

/**
 * BM-6: the desk's "Refund or chargeback" — the member's purchases that took rand with what is left
 * on each, the rand and the minutes asked separately and capped at what is left, a confirm that
 * states the balance after, the exact snake_case body, and the desk's lost-reply discipline.
 */
afterEach(() => vi.unstubAllGlobals());

const USER = "44444444-4444-4444-4444-444444444444";
const LIST = `/api/v1/admin/minutes/${USER}/reversible`;
const POST = `/api/v1/admin/minutes/${USER}/reverse-payment`;

function entry(overrides: Partial<ReversibleEntry> = {}): ReversibleEntry {
  return {
    entry_id: "e-five", type: "TopUp", created_at: "2026-11-02T16:30:00Z", reason: "5 hours (PayFast)",
    zar_paid: 495, amount_minutes: 300, zar_reversed: 0, minutes_taken_back: 0, zar_left: 495, minutes_left: 300,
    ...overrides,
  };
}

const recorded = {
  entry_id: "r1", type: "PaymentReversal", kind: "refund", amount_minutes: -300, zar_reversed: 495, reverses_entry_id: "e-five",
  zar_left: 0, minutes_left: 0, balance_before_minutes: 420, balance_after_minutes: 120,
};

function draw(routes: StubRoute[], onRecorded = vi.fn(), balance: number | null = 420) {
  const stub = stubFetch(routes);
  renderPage(<ReversePaymentSheet userId={USER} name="Thandi" balance={balance} onClose={() => {}} onRecorded={onRecorded} />);
  return { stub, onRecorded };
}

async function choose(name: RegExp) {
  fireEvent.click(await screen.findByRole("radio", { name }));
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
}

async function amounts(values: { zar?: string; minutes?: string; note?: string; chargeback?: boolean }) {
  if (values.chargeback) fireEvent.click(await screen.findByRole("radio", { name: new RegExp(COPY.kinds.chargeback.title) }));
  if (values.zar !== undefined) fireEvent.change(await screen.findByLabelText(COPY.zarLabel), { target: { value: values.zar } });
  if (values.minutes !== undefined) fireEvent.change(screen.getByLabelText(COPY.minutesLabel), { target: { value: values.minutes } });
  if (values.note !== undefined) fireEvent.change(screen.getByLabelText(new RegExp(`^${COPY.noteLabel}\\b`)), { target: { value: values.note } });
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
}

async function confirm() {
  fireEvent.click(await screen.findByRole("button", { name: /^Record (refund|chargeback) of/ }), { detail: 1 });
  fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
}

const posts = (stub: ReturnType<typeof stubFetch>) => stub.calls.filter((c) => c.method === "POST" && c.path === POST);

describe("choosing the purchase", () => {
  it("lists what each purchase took and what is left, and a purchase given back in full cannot be chosen", async () => {
    draw([{ path: LIST, body: { entries: [entry(), entry({ entry_id: "e-done", reason: "1 hour (desk)", zar_left: 0, minutes_left: 0, zar_reversed: 120 })] } }]);
    expect(await screen.findByRole("radio", { name: /5 hours \(PayFast\)/ })).toBeEnabled();
    expect(screen.getByText("R495.00 and 5 hours can still be given back")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /1 hour \(desk\)/ })).toBeDisabled();
    expect(screen.getByText(COPY.nothingLeft)).toBeInTheDocument();
  });

  it("refuses Next with nothing chosen, and says so at the list", async () => {
    draw([{ path: LIST, body: { entries: [entry()] } }]);
    await screen.findByRole("radio", { name: /5 hours/ });
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(await screen.findByText(COPY.pickMissing)).toBeInTheDocument();
  });

  it("says plainly when nothing took rand, and offers a re-read when the read failed", async () => {
    draw([{ path: LIST, body: { entries: [] } }]);
    expect(await screen.findByText(COPY.emptyTitle)).toBeInTheDocument();
  });
});

describe("the amounts", () => {
  it("start at everything left on the purchase and refuse more than is left, or a note left out", async () => {
    draw([{ path: LIST, body: { entries: [entry({ zar_left: 200, minutes_left: 90 })] } }]);
    await choose(/5 hours/);
    expect(screen.getByLabelText(COPY.zarLabel)).toHaveValue("200.00");
    expect(screen.getByLabelText(COPY.minutesLabel)).toHaveValue("90");
    await amounts({ zar: "250", minutes: "120" });
    expect(await screen.findByText(COPY.zarTooMuch("R200.00"))).toBeInTheDocument();
    expect(screen.getByText(COPY.minutesTooMany(90))).toBeInTheDocument();
    expect(screen.getByText(COPY.noteMissing)).toBeInTheDocument();
    await amounts({ zar: "12.345", minutes: "1.5", note: "x" });
    expect(await screen.findByText(COPY.zarNotCents)).toBeInTheDocument();
    expect(screen.getByText(COPY.minutesInvalid)).toBeInTheDocument();
  });
});

describe("recording it", () => {
  it("posts the exact body, states the balance after, and keeps a receipt", async () => {
    const { stub, onRecorded } = draw([
      { path: LIST, body: { entries: [entry()] } },
      { method: "POST", path: POST, body: recorded },
    ]);
    await choose(/5 hours/);
    await amounts({ note: "Court lights failed, EFT" });
    expect(await screen.findByText("R495.00 comes off the club's revenue for the day it is recorded.")).toBeInTheDocument();
    await confirm();

    await screen.findByText("Refund of R495.00 recorded. Balance now 2 hours.");
    expect(onRecorded).toHaveBeenCalledWith(120);
    const body = posts(stub)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ entry_id: "e-five", kind: "refund", zar_reversed: 495, minutes_taken_back: 300, reason: "Court lights failed, EFT" });
    expect(typeof body.idempotency_key).toBe("string");
  });

  it("records a chargeback with the member keeping their minutes, and warns of nothing when nothing goes below zero", async () => {
    const { stub } = draw([
      { path: LIST, body: { entries: [entry({ zar_left: 150, minutes_left: 60 })] } },
      { method: "POST", path: POST, body: { ...recorded, kind: "chargeback", amount_minutes: 0, zar_reversed: 150, balance_after_minutes: 420 } },
    ], vi.fn(), 30);
    await choose(/5 hours/);
    await amounts({ chargeback: true, minutes: "0", note: "Bank dispute 18 Nov" });
    expect(screen.queryByText(COPY.overdraws)).not.toBeInTheDocument();
    await confirm();
    await screen.findByText(/^Chargeback of R150.00 recorded/);
    expect(posts(stub)[0].body).toMatchObject({ kind: "chargeback", zar_reversed: 150, minutes_taken_back: 0 });
  });

  it("warns before taking a balance below zero", async () => {
    draw([{ path: LIST, body: { entries: [entry()] } }], vi.fn(), 30);
    await choose(/5 hours/);
    await amounts({ note: "Refunded" });
    expect(await screen.findByText(COPY.overdraws)).toBeInTheDocument();
  });

  it("a second desk that got there first is said in words, and the amounts are checked again against what is left", async () => {
    const { stub } = draw([
      { path: LIST, body: { entries: [entry()] } },
      { method: "POST", path: POST, body: refuse(409, { error: "reversal_exceeds_payment", zar_left: 100, minutes_left: 30 }) },
    ]);
    await choose(/5 hours/);
    await amounts({ note: "Refund" });
    await confirm();
    expect((await screen.findAllByText(/only R100.00 and 30 minutes are left/)).length).toBeGreaterThan(0);
    // Back on the amounts, and Next now refuses the R495 that no longer fits.
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(await screen.findByText(COPY.zarTooMuch("R100.00"))).toBeInTheDocument();
    expect(posts(stub)).toHaveLength(1);
  });
});

describe("a lost reply", () => {
  it("is looked up on the purchase: found, it is a receipt that says it was checked", async () => {
    const onRecorded = vi.fn();
    const stub = stubFetch([
      { path: LIST, sequence: [{ entries: [entry()] }, { entries: [entry({ zar_reversed: 495, minutes_taken_back: 300, zar_left: 0, minutes_left: 0 })] }] },
      { method: "POST", path: POST, respond: () => { throw new TypeError("Failed to fetch"); } },
    ]);
    renderPage(<ReversePaymentSheet userId={USER} name="Thandi" balance={420} onClose={() => {}} onRecorded={onRecorded} />);
    await choose(/5 hours/);
    await amounts({ note: "Refund" });
    await confirm();
    expect(await screen.findByText(REVERSAL_LOST.landed)).toBeInTheDocument();
    expect(onRecorded).toHaveBeenCalledWith(null);
    expect(posts(stub)).toHaveLength(1);
  });

  it("read and not there: says nothing was recorded, and the next press goes under the SAME key", async () => {
    const stub = stubFetch([
      { path: LIST, body: { entries: [entry()] } },
      { method: "POST", path: POST, respond: (req) => {
        if (stub.calls.filter((c) => c.method === "POST").length === 1) throw new TypeError("Failed to fetch");
        return { ...recorded, reverses_entry_id: (req.body as { entry_id: string }).entry_id };
      } },
    ]);
    renderPage(<ReversePaymentSheet userId={USER} name="Thandi" balance={420} onClose={() => {}} onRecorded={() => {}} />);
    await choose(/5 hours/);
    await amounts({ note: "Refund" });
    await confirm();
    expect(await screen.findByText(REVERSAL_LOST.absent)).toBeInTheDocument();
    await confirm();
    await screen.findByText(/^Refund of R495.00 recorded/);
    const [first, second] = posts(stub).map((c) => (c.body as { idempotency_key: string }).idempotency_key);
    expect(second).toBe(first);
  });

  it("unreadable as well: never says it failed, and points at the ledger", async () => {
    const reads = { n: 0 };
    stubFetch([
      { path: LIST, respond: () => {
        reads.n += 1;
        if (reads.n > 1) throw new TypeError("Failed to fetch");
        return { entries: [entry()] };
      } },
      { method: "POST", path: POST, respond: () => { throw new TypeError("Failed to fetch"); } },
    ]);
    renderPage(<ReversePaymentSheet userId={USER} name="Thandi" balance={420} onClose={() => {}} onRecorded={() => {}} />);
    await choose(/5 hours/);
    await amounts({ note: "Refund" });
    await confirm();
    await waitFor(() => expect(screen.getAllByText(REVERSAL_LOST.unknown("Thandi")).length).toBeGreaterThan(0));
  });
});
