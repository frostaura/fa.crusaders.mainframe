import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminCourtsPage from "../AdminCourts";
import { courtFixture, refuse, renderPage, stubFetch, type StubRoute } from "@/test/harness";
import { COURTS_COPY } from "@/lib/courtsCopy";

/**
 * Admin · Courts — the Courts editor, moved out of Settings (plan P6).
 *
 * <p>
 * Held here: a court has no price (P13, contract §3.9) — not on the list, not in the sheet, not on
 * the wire; a failed read is never the empty state; an add is refused at the sheet when it has no
 * name, not by a toast; an edit sends only what changed; and taking a court out of use is the
 * API's soft deactivation.
 * </p>
 */
afterEach(() => vi.unstubAllGlobals());

const COURTS = [courtFixture(1), courtFixture(2, { is_active: false }), courtFixture(3, { name: "Glass court" })];

const routes = (extra: StubRoute[] = []): StubRoute[] => [
  { path: "/api/v1/admin/courts/", body: COURTS },
  ...extra,
];

/** Nothing on a court may be a price: no rand, no "cr", no "slice" price, no "credit". */
const PRICE_WORDS = /\bcr\b|credit|price|\bR\s?\d|per slice/i;

describe("the courts list", () => {
  it("lists every court with its number, its type and whether it is in use — and no price", async () => {
    stubFetch(routes());
    renderPage(<AdminCourtsPage />);

    const list = await screen.findByRole("region", { name: COURTS_COPY.listLabel });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Court number 1");
    expect(rows[0]).toHaveTextContent("Squash");
    expect(rows[0]).toHaveTextContent(COURTS_COPY.inUse);
    expect(rows[1]).toHaveTextContent(COURTS_COPY.notInUse);
    expect(rows[2]).toHaveTextContent("Glass court");
    expect(list).toHaveTextContent(COURTS_COPY.count(2, 3));
    expect(list.textContent).not.toMatch(PRICE_WORDS);
    expect(document.body.textContent).not.toMatch(PRICE_WORDS);
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
  /** P13 §3.9: the sheet is the name and the in-use switch — there is nothing to price. */
  it("edits a court's name and whether it is in use, and nothing that costs anything", async () => {
    stubFetch(routes());
    renderPage(<AdminCourtsPage />);

    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Court 1") }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.editTitle("Court 1") });
    expect(within(dialog).getByLabelText(COURTS_COPY.nameLabel)).toHaveValue("Court 1");
    expect(within(dialog).getByRole("switch", { name: COURTS_COPY.activeLabel })).toBeChecked();
    expect(within(dialog).queryAllByRole("spinbutton")).toHaveLength(0);
    expect(dialog.textContent).not.toMatch(PRICE_WORDS);
    expect(within(dialog).getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("sends only what changed, then closes and re-reads", async () => {
    const stub = stubFetch(routes([
      { method: "PATCH", path: "/api/v1/admin/courts/", body: { saved: true } },
    ]));
    renderPage(<AdminCourtsPage />);

    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Glass court") }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.editTitle("Glass court") });
    fireEvent.change(within(dialog).getByLabelText(COURTS_COPY.nameLabel), { target: { value: "Glass hall" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveEdit }));

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      expect(patch?.path).toBe(`/api/v1/admin/courts/${COURTS[2].id}`);
      expect(patch?.body).toEqual({ name: "Glass hall" });
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
      { method: "PATCH", path: "/api/v1/admin/courts/", status: 400, body: { error: "name_required" } },
    ]));
    renderPage(<AdminCourtsPage />);

    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Court 1") }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(COURTS_COPY.nameLabel), { target: { value: "Court One" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveEdit }));

    expect(await within(dialog).findByText(new RegExp(COURTS_COPY.errorCodes.name_required))).toBeInTheDocument();
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

  it("posts the name and the type only — no price on the wire", async () => {
    const stub = stubFetch(routes([{ method: "POST", path: "/api/v1/admin/courts/", body: { id: "new", court_number: 4 } }]));
    renderPage(<AdminCourtsPage />);

    await screen.findByRole("region", { name: COURTS_COPY.listLabel });
    fireEvent.click(screen.getByRole("button", { name: COURTS_COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.addTitle });
    expect(dialog.textContent).not.toMatch(PRICE_WORDS);
    fireEvent.change(screen.getByLabelText(COURTS_COPY.nameLabel), { target: { value: "  Court 5  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveNew }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual({ name: "Court 5", courtType: "Squash" });
      expect(Object.keys(post?.body as object)).toEqual(["name", "courtType"]);
    });
    expect(await screen.findByText(COURTS_COPY.added("Court 5"))).toBeInTheDocument();
  });
});

/**
 * Review round 3 (admin lost-reply audit): a court save whose reply is lost is read back from
 * the courts list. The stubs perform the PATCH, then fail the reply. With no price (P13), the
 * read-back compares what a court still has: its name and whether it is in use.
 */
describe("a court save whose reply was lost", () => {
  afterEach(() => vi.unstubAllGlobals());

  function lost(landed: boolean, readable = true): StubRoute[] {
    let courts = COURTS;
    let reads = 0;
    return [
      { path: "/api/v1/admin/courts/", respond: () => (++reads > 1 && !readable ? refuse(503, { error: "down" }) : courts) },
      {
        method: "PATCH", path: "/api/v1/admin/courts/",
        respond: () => {
          if (landed) courts = COURTS.map((c) => (c.id === COURTS[2].id ? { ...c, is_active: false } : c));
          return refuse(504, { error: "gateway_timeout" });
        },
      },
    ];
  }
  async function save() {
    fireEvent.click(await screen.findByRole("button", { name: COURTS_COPY.editLabel("Glass court") }));
    const dialog = await screen.findByRole("dialog", { name: COURTS_COPY.editTitle("Glass court") });
    fireEvent.click(within(dialog).getByRole("switch", { name: COURTS_COPY.activeLabel }));
    fireEvent.click(within(dialog).getByRole("button", { name: COURTS_COPY.saveEdit }));
    return dialog;
  }

  it("says it saved when the list shows the court out of use", async () => {
    stubFetch(lost(true));
    renderPage(<AdminCourtsPage />);
    await save();
    expect(await screen.findByText(`${COURTS_COPY.saved("Glass court")} The club's reply didn't arrive, so we checked its record.`)).toBeInTheDocument();
  });

  it("says nothing changed when the list still shows it in use", async () => {
    stubFetch(lost(false));
    renderPage(<AdminCourtsPage />);
    const dialog = await save();
    expect(await within(dialog).findByText(/we checked: Glass court still has its old details — nothing changed/)).toBeInTheDocument();
  });

  it("says it cannot tell when the list cannot be read either", async () => {
    stubFetch(lost(true, false));
    renderPage(<AdminCourtsPage />);
    const dialog = await save();
    expect(await within(dialog).findByText(/can't tell whether Glass court was saved/)).toBeInTheDocument();
  });
});
