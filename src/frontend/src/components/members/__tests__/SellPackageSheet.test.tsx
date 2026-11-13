import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SellPackageSheet } from "../SellPackageSheet";
import { ledgerRowFixture, refuse, renderPage, stubFetch, type StubRoute } from "../../../test/harness";
import { PACKAGE_IDS, discountedShelf, seededShelf } from "../../../test/minutesFixtures";
import { LIVE_SAID, LOST_REPLY, PAYMENT_CHOICES, SELL_COPY as COPY } from "../../../lib/deskMinutesCopy";

/** BA-20: the note's label says "(required)" up front, so it is found by its first word. */
const SALE_NOTE = new RegExp(`^${COPY.detailLabel}\\b`);

/**
 * The desk's "Sell package" (P13 §3.7): the member's OWN shelf (their discount, their groups'
 * packages), how it was paid, the money received defaulting to their price, a confirm that states
 * the balance after, and the adjust path's press discipline — one key per sale, a lost reply
 * looked up on the ledger, a changed shelf said in words.
 */
afterEach(() => vi.unstubAllGlobals());

const USER = "44444444-4444-4444-4444-444444444444";
const SHELF = `/api/v1/admin/minutes/${USER}/packages`;
const SELL = `/api/v1/admin/minutes/${USER}/sell`;
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

const sold = { entry_id: "e1", type: "AdminTopUp", reason_code: "top_up_cash", amount_minutes: 300, zar_received: 495,
  balance_before_minutes: 120, balance_after_minutes: 420, member: { user_id: USER, email: "t@x.test" },
  package: { id: PACKAGE_IDS.five, name: "5 hours", minutes: 300, price_zar: 495 } };

function draw(routes: StubRoute[], onSold = vi.fn()) {
  const stub = stubFetch(routes);
  renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={onSold} />);
  return { stub, onSold };
}

async function choosePackage(name: RegExp) {
  fireEvent.click(await screen.findByRole("radio", { name }));
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
}

async function pay(how: string, note: string, zar?: string) {
  fireEvent.pointerDown(await screen.findByRole("combobox", { name: COPY.paymentLabel }), POINTER);
  fireEvent.click(await screen.findByRole("option", { name: how }));
  if (zar !== undefined) fireEvent.change(screen.getByLabelText(COPY.zarLabel), { target: { value: zar } });
  // BA-20: required, and said so before a failed Next — in the label and to assistive tech.
  expect(screen.getByLabelText(SALE_NOTE)).toHaveAttribute("aria-required", "true");
  expect(screen.getByText("(required)")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(SALE_NOTE), { target: { value: note } });
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
}

async function confirm() {
  fireEvent.click(await screen.findByRole("button", { name: /^Sell / }), { detail: 1 });
  fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
}

describe("the member's own shelf", () => {
  it("reads THIS member's shelf and shows what they pay, the list price and the saving", async () => {
    const { stub } = draw([{ path: SHELF, body: { discount: discountedShelf().discount, packages: discountedShelf().packages } }]);
    const five = await screen.findByRole("radio", { name: /5 hours/ });
    expect(stub.calls[0].path).toBe(SHELF);
    expect(five).toHaveTextContent("R495.00");
    expect(five).toHaveAccessibleDescription(expect.stringContaining(COPY.listPrice("R550.00")));
    expect(five).toHaveAccessibleDescription(expect.stringContaining(COPY.saving("R45.00", 8)));
    // The discount is said once, under the title — why the prices are what they are.
    expect(document.body).toHaveTextContent(COPY.discountLine("10%", "League"));
    expect(document.body.textContent).not.toMatch(/credit|\bcr\b/i);
  });

  it("says the shelf could not be read — never that there is nothing to sell", async () => {
    draw([{ path: SHELF, status: 503, body: { error: "down" } }]);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(COPY.shelfEmptyTitle)).toBeNull();
  });

  it("says when there is genuinely nothing to sell, and where packages are made", async () => {
    draw([{ path: SHELF, body: { discount: null, packages: [] } }]);
    expect(await screen.findByText(COPY.shelfEmptyTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: COPY.shelfEmptyAction })).toHaveAttribute("href", "/admin/packages");
  });

  it("asks for a package before moving on", async () => {
    draw([{ path: SHELF, body: { discount: null, packages: seededShelf() } }]);
    await screen.findByRole("radio", { name: /1 hour/ });
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(screen.getByText(COPY.pickPackage)).toBeInTheDocument();
  });
});

describe("selling", () => {
  it("defaults the money to the member's price, sends no rand when it is that, and keeps the receipt", async () => {
    const { stub, onSold } = draw([
      { path: SHELF, body: { discount: discountedShelf().discount, packages: discountedShelf().packages } },
      { method: "POST", path: SELL, body: sold },
    ]);
    await choosePackage(/5 hours/);
    expect(screen.getByLabelText(COPY.zarLabel)).toHaveValue("495.00");
    await pay(PAYMENT_CHOICES[0].label, "Receipt 0412");

    // The figures before the press: now, the package, after, and the money.
    const check = document.querySelector("dl")!;
    expect(within(check).getAllByText("2 hours").length).toBeGreaterThan(0);
    expect(check).toHaveTextContent("7 hours");
    expect(check).toHaveTextContent("R495.00");
    await confirm();

    await waitFor(() => expect(stub.calls.find((c) => c.method === "POST")?.body).toEqual(expect.objectContaining({
      packageId: PACKAGE_IDS.five, reasonCode: "top_up_cash", reason: "Receipt 0412",
    })));
    const body = stub.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    // R9 J9-1: the rand is always stated — the server no longer prices a sale itself.
    expect(body.zarReceived).toBe(495);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(await screen.findByText("Done. Thandi now has 7 hours.", { selector: "[role='status']" })).toBeInTheDocument();
    expect(screen.getByText(COPY.receipt("Thandi", "5 hours", 300))).toBeInTheDocument();
    expect(onSold).toHaveBeenCalledWith(420);
  });

  it("sends the money received when the desk took something else, and says it differs", async () => {
    const { stub } = draw([
      { path: SHELF, body: { discount: null, packages: seededShelf() } },
      { method: "POST", path: SELL, body: { ...sold, zar_received: 500 } },
    ]);
    await choosePackage(/5 hours/);
    fireEvent.change(screen.getByLabelText(COPY.zarLabel), { target: { value: "500" } });
    expect(screen.getByText(COPY.zarDiffers("R550.00"))).toBeInTheDocument();
    await pay(PAYMENT_CHOICES[1].label, "EFT ref 77", "500");
    await confirm();
    await waitFor(() => expect(stub.calls.find((c) => c.method === "POST")?.body)
      .toEqual(expect.objectContaining({ zarReceived: 500, reasonCode: "top_up_eft" })));
  });

  it("says a shelf that changed under the desk, and reads it again", async () => {
    const { stub } = draw([
      { path: SHELF, body: { discount: null, packages: seededShelf() } },
      { method: "POST", path: SELL, status: 409, body: { error: "package_unavailable" } },
    ]);
    await choosePackage(/10 hours/);
    await pay(PAYMENT_CHOICES[0].label, "Cash");
    await confirm();
    expect(await screen.findAllByText(COPY.unavailable)).not.toHaveLength(0);
    await waitFor(() => expect(stub.calls.filter((c) => c.path === SHELF)).toHaveLength(2));
    expect(await screen.findByRole("radio", { name: /10 hours/ })).not.toBeChecked();
  });
});

/** The adjust path's lost-reply rule (review round 2, F3-2), on the sale. */
describe("a sale whose reply was lost", () => {
  function landedThenLost(): StubRoute[] {
    const ledger: Array<ReturnType<typeof ledgerRowFixture>> = [];
    return [
      { path: SHELF, body: { discount: null, packages: seededShelf() } },
      { path: `/api/v1/admin/members/${USER}`, respond: () => ({ balance_minutes: 120 + ledger.length * 300 }) },
      { path: "/api/v1/admin/ledger/", respond: () => ledger },
      {
        method: "POST", path: SELL,
        respond: (req: { body: unknown }) => {
          const b = req.body as Record<string, unknown>;
          ledger.push(ledgerRowFixture({ id: "s1", type: "AdminTopUp", amountMinutes: 300, signedAmountMinutes: 300, comment: `${b.reason} — 5 hours`, subjectUserId: USER }));
          return refuse(504, { error: "gateway_timeout" });
        },
      },
    ];
  }

  it("finds the sale on the ledger and shows the receipt — never 'didn't go through'", async () => {
    const { stub } = draw(landedThenLost());
    await choosePackage(/5 hours/);
    await pay(PAYMENT_CHOICES[0].label, "Cash 0413");
    await confirm();
    expect(await screen.findByText("Done. Thandi now has 7 hours.", { selector: "[role='status']" })).toBeInTheDocument();
    expect(screen.getByText(LOST_REPLY.landed)).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("keeps the key when nothing landed, so a second press cannot sell twice", async () => {
    const { stub } = draw([
      { path: SHELF, body: { discount: null, packages: seededShelf() } },
      { path: "/api/v1/admin/ledger/", body: [] },
      { method: "POST", path: SELL, status: 500, body: { error: "boom" } },
    ]);
    await choosePackage(/5 hours/);
    await pay(PAYMENT_CHOICES[0].label, "Cash 0414");
    await confirm();
    const live = () => document.querySelector("[data-confirm-group] > [aria-live='polite']");
    await waitFor(() => expect(live()).toHaveTextContent(LIVE_SAID.absent));
    await confirm();
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [first, second] = stub.calls.filter((c) => c.method === "POST");
    const key = (b: unknown) => (b as Record<string, unknown>).idempotencyKey;
    expect(key(second.body)).toBe(key(first.body));
  });
});
