import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminCourtsPage from "../AdminCourts";
import { courtFixture, renderPage, stubFetch, type StubRoute } from "@/test/harness";
import { COURTS_COPY } from "@/lib/courtsCopy";

/**
 * Admin · Courts — the Courts editor, moved out of Settings (plan P6).
 *
 * <p>
 * Held here: prices are credits and are labelled so (the field once said "(R)"); a failed read is
 * never the empty state; an add is refused at the sheet when it has no name, not by a toast; an
 * edit sends only what changed; and taking a court out of use is the API's soft deactivation.
 * </p>
 */
afterEach(() => vi.unstubAllGlobals());

const COURTS = [courtFixture(1), courtFixture(2, { is_active: false }), courtFixture(3, { name: "Glass court", slice_price_credits: 12.5 })];

const routes = (extra: StubRoute[] = []): StubRoute[] => [
  { path: "/api/v1/admin/courts/", body: COURTS },
  ...extra,
];

const priceField = () => screen.getByLabelText(COURTS_COPY.priceLabel);

describe("the courts list", () => {
  it("lists every court with its number, its price in credits and whether it is in use", async () => {
    stubFetch(routes());
    renderPage(<AdminCourtsPage />);

    const list = await screen.findByRole("region", { name: COURTS_COPY.listLabel });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Court number 1");
    expect(rows[0]).toHaveTextContent("8 cr a slice");
    expect(rows[0]).toHaveTextContent(COURTS_COPY.inUse);
    expect(rows[1]).toHaveTextContent(COURTS_COPY.notInUse);
    expect(rows[2]).toHaveTextContent("12.50 cr a slice");
    expect(list).toHaveTextContent(COURTS_COPY.count(2, 3));
  });

  /** An empty collection on a failed read is not an answer: the failure, a retry, no "No courts". */
  it("says the read failed rather than that the club has no courts", async () => {
    stubFetch([{ path: "/api/v1/admin/courts/", status: 408, body: { error: "timeout" } }]);
    renderPage(<AdminCourtsPage />);

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(COURTS_COPY.emptyTitle)).toBeNull();
  });

  it("says so, with the way forward, when the club really has none", async () => {
    stubFetch([{ path: "/api/v1/admin/courts/", body: [] }]);
    renderPage(<AdminCourtsPage />);

    expect(await screen.findByText(COURTS_COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: COURTS_COPY.add })).toHaveLength(2);
  });
});

describe("editing a court", () => {
  /**
   * A court's slice price is what a member is CHARGED, in credits — the unit of account. The field
   * was once labelled "(R)", so an admin priced courts in the wrong unit. (Moved from
   * AdminSettings.test.tsx with the editor.)
   */
  it("prices courts in credits, not rand", async () => {
    stubFetch(routes());
    renderPage(<AdminCourtsPage />);

    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Court 1") }));
    await screen.findByRole("dialog", { name: COURTS_COPY.editTitle("Court 1") });
    expect(priceField()).toHaveValue(8);
    expect(screen.queryByLabelText(/Price per slice \(R\)/)).toBeNull();
    expect(screen.getByText(COURTS_COPY.priceDescription)).toBeInTheDocument();
  });

  it("sends only what changed, then closes and re-reads", async () => {
    const stub = stubFetch(routes([
      { method: "PATCH", path: "/api/v1/admin/courts/", body: { saved: true } },
    ]));
    renderPage(<AdminCourtsPage />);

    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Glass court") }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.editTitle("Glass court") });
    fireEvent.change(priceField(), { target: { value: "14" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveEdit }));

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      expect(patch?.path).toBe(`/api/v1/admin/courts/${COURTS[2].id}`);
      expect(patch?.body).toEqual({ slicePriceCredits: 14 });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/admin/courts/")).toHaveLength(2);
  });

  /** Out of use is the API's own soft deactivation: history stays coherent, and it can come back. */
  it("takes a court out of use with the switch, saying what that does", async () => {
    const stub = stubFetch(routes([
      { method: "PATCH", path: "/api/v1/admin/courts/", body: { saved: true } },
    ]));
    renderPage(<AdminCourtsPage />);

    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Court 1") }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("switch", { name: COURTS_COPY.activeLabel }));
    expect(dialog).toHaveTextContent(COURTS_COPY.activeOff);
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveEdit }));

    await waitFor(() => {
      expect(stub.calls.find((c) => c.method === "PATCH")?.body).toEqual({ isActive: false });
    });
  });

  it("keeps the sheet open and says why when the save is refused", async () => {
    stubFetch(routes([
      { method: "PATCH", path: "/api/v1/admin/courts/", status: 400, body: { error: "price_negative" } },
    ]));
    renderPage(<AdminCourtsPage />);

    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Court 1") }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(priceField(), { target: { value: "9" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveEdit }));

    expect(await within(dialog).findByText(/The price can't be below 0/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("adding a court", () => {
  it("refuses a court with no name at the sheet, with focus on the name, and sends nothing", async () => {
    const stub = stubFetch(routes([{ method: "POST", path: "/api/v1/admin/courts/", body: { id: "new", court_number: 4 } }]));
    renderPage(<AdminCourtsPage />);

    await screen.findByRole("region", { name: COURTS_COPY.listLabel });
    fireEvent.click(screen.getByRole("button", { name: COURTS_COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.addTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveNew }));

    expect(within(dialog).getByText(COURTS_COPY.nameRequired)).toBeInTheDocument();
    expect(screen.getByLabelText(COURTS_COPY.nameLabel)).toHaveFocus();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("starts at the club's usual price, and posts the name and price in credits", async () => {
    const stub = stubFetch(routes([{ method: "POST", path: "/api/v1/admin/courts/", body: { id: "new", court_number: 4 } }]));
    renderPage(<AdminCourtsPage />);

    await screen.findByRole("region", { name: COURTS_COPY.listLabel });
    fireEvent.click(screen.getByRole("button", { name: COURTS_COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.addTitle });
    // Court 1 (8) and the glass court (12.5) are in use; 8 is not "usual" by count alone — the
    // tie goes to the first seen, which is the lowest-numbered court's price.
    expect(priceField()).toHaveValue(8);
    fireEvent.change(screen.getByLabelText(COURTS_COPY.nameLabel), { target: { value: "  Court 5  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveNew }));

    await waitFor(() => {
      expect(stub.calls.find((c) => c.method === "POST")?.body)
        .toEqual({ name: "Court 5", courtType: "Squash", slicePriceCredits: 8 });
    });
    expect(await screen.findByText(COURTS_COPY.added("Court 5"))).toBeInTheDocument();
  });

  it("refuses a price in fractions of a cent", async () => {
    stubFetch(routes());
    renderPage(<AdminCourtsPage />);

    await screen.findByRole("region", { name: COURTS_COPY.listLabel });
    fireEvent.click(screen.getByRole("button", { name: COURTS_COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.addTitle });
    fireEvent.change(screen.getByLabelText(COURTS_COPY.nameLabel), { target: { value: "Court 5" } });
    fireEvent.change(priceField(), { target: { value: "8.005" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveNew }));

    expect(within(dialog).getByText(COURTS_COPY.priceInvalid)).toBeInTheDocument();
    expect(priceField()).toHaveFocus();
  });
});
