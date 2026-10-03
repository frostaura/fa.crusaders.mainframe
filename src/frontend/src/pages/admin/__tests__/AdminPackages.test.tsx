import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminPackagesPage from "../AdminPackages";
import { refuse, renderPage, stubFetch, type StubRoute } from "@/test/harness";
import { adminPackage } from "@/test/adminResponseFixtures";
import { PACKAGES_COPY as COPY } from "@/lib/packagesCopy";
import type { AdminPackage } from "@/lib/adminApi";

/**
 * Admin · Packages (P13 §3.5, §4) — the club's shelf and each group's, the editor with its
 * live sum, retiring (never deleting), and the three honest reads.
 */
afterEach(() => vi.unstubAllGlobals());

const LEAGUE = { id: "g-league", name: "League", status: "active", system_key: "league", package_discount_bps: 1000, peak_priority: true };
const PACKAGES: AdminPackage[] = [
  adminPackage({ id: "p1", name: "1 hour", minutes: 60, price_zar: 120, sort_order: 0 }),
  adminPackage({ id: "p5", name: "5 hours", minutes: 300, price_zar: 550, sort_order: 1 }),
  adminPackage({ id: "p10", name: "10 hours", minutes: 600, price_zar: 1000, sort_order: 2 }),
  adminPackage({ id: "pl", name: "League night", minutes: 90, price_zar: 150, group: { id: "g-league", name: "League" }, sort_order: 0 }),
  adminPackage({ id: "old", name: "Winter special", minutes: 120, price_zar: 200, status: "archived" }),
];

const routes = (extra: StubRoute[] = [], packages: AdminPackage[] = PACKAGES): StubRoute[] => [
  { path: "/api/v1/admin/packages", body: { packages } },
  { path: "/api/v1/admin/member-groups", body: { groups: [LEAGUE] } },
  ...extra,
];

const minutesShown = (el: HTMLElement) => [...el.querySelectorAll("[aria-hidden='true']")].map((n) => n.textContent);

describe("the shelves", () => {
  it("lists the club's shelf first, then each group's, with minutes, price, rate and saving", async () => {
    stubFetch(routes());
    renderPage(<AdminPackagesPage />);

    const club = await screen.findByRole("list", { name: COPY.listLabel(COPY.clubShelf) });
    const rows = within(club).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByText(/hour/, { selector: "p" }).textContent)).toEqual(["1 hour", "5 hours", "10 hours"]);
    expect(minutesShown(rows[1])).toContain("5 h");
    expect(rows[1]).toHaveTextContent("R550.00");
    expect(rows[1]).toHaveTextContent(COPY.perHour(110));
    // §4.3's own example: against 1 hour at R120.
    expect(rows[1]).toHaveTextContent(COPY.saves(50, 8));
    expect(rows[2]).toHaveTextContent(COPY.saves(200, 16));
    expect(rows[0]).not.toHaveTextContent(/Saves|R\d+\.\d\d \(/);

    const league = screen.getByRole("list", { name: COPY.listLabel("League") });
    expect(league).toHaveTextContent("League night");
    expect(minutesShown(league)).toContain("1 h 30 min");
    expect(screen.getByText(COPY.groupShelfHint("League"))).toBeInTheDocument();
    // On sale only: the retired one is behind its own view.
    expect(screen.queryByText("Winter special")).toBeNull();
    expect(screen.getByText(COPY.count(4))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/credit|\bcr\b|\d\.\d+ min/i);
  });

  /**
   * Review round 6, J6-5 — contract §4.3's baseline is the MEMBER's shelf, and a group member's
   * shelf is the group's packages AND the club's at that group's discount (§4.2, Dean's answer 2).
   * Measured against the group's packages alone, League night was "the only package on this
   * shelf" with no saving, where a League member sees it beside 1 hour at R108.00 (10 % off R120).
   */
  it("measures a group package's saving against the member's whole shelf, club packages at the group's discount", async () => {
    stubFetch(routes());
    renderPage(<AdminPackagesPage />);
    const league = await screen.findByRole("list", { name: COPY.listLabel("League") });
    // 108 × 90 ÷ 60 − 150 = R12.00; floor(100 × (1 − 150 × 60 ÷ (90 × 108))) = 7 %.
    expect(within(league).getAllByRole("listitem")[0]).toHaveTextContent(COPY.saves(12, 7));
  });

  it("says the same in the editor's preview for a package on a group's shelf", async () => {
    stubFetch(routes());
    renderPage(<AdminPackagesPage />);
    await screen.findByRole("list", { name: COPY.listLabel(COPY.clubShelf) });
    fireEvent.click(within(await screen.findByRole("list", { name: COPY.listLabel("League") })).getByRole("button", { name: COPY.editLabel("League night") }));
    const dialog = await screen.findByRole("dialog");
    const preview = dialog.querySelector("[data-package-preview]")!;
    expect(preview).not.toHaveTextContent(COPY.previewAlone);
    expect(preview).toHaveTextContent("Saves R12.00 (7%) against 1 hour (R108.00).");
  });

  it("shows the retired packages in their own view, read-only", async () => {
    stubFetch(routes());
    renderPage(<AdminPackagesPage />);
    fireEvent.click(await screen.findByRole("radio", { name: COPY.viewArchived }));
    expect(await screen.findByText("Winter special")).toBeInTheDocument();
    expect(screen.queryByText("5 hours")).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.editLabel("Winter special") })).toBeNull();
    expect(screen.getByText(COPY.retiredOn)).toBeInTheDocument();
  });

  /** An empty collection on a failed read is not an answer: the failure, a retry, no "No packages". */
  it("says the read failed rather than that the club has no packages", async () => {
    stubFetch([
      { path: "/api/v1/admin/packages", status: 503, body: { error: "down" } },
      { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    ]);
    renderPage(<AdminPackagesPage />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyTitle)).toBeNull();
    expect(document.body).toHaveTextContent(COPY.readCaveat);
  });

  it("says so, with the way forward, when the club really has none", async () => {
    stubFetch(routes([], []));
    renderPage(<AdminPackagesPage />);
    expect(await screen.findByText(COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: COPY.add }).length).toBeGreaterThanOrEqual(2);
  });

  it("stops adding at the club's 50, and says why", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => adminPackage({ id: `p${i}`, name: `Pack ${i}`, minutes: 60 + i }));
    stubFetch(routes([], fifty));
    renderPage(<AdminPackagesPage />);
    expect(await screen.findByText(COPY.atLimit)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: COPY.add })[0]).toBeDisabled();
  });
});

describe("adding a package", () => {
  async function openAdd() {
    await screen.findByRole("list", { name: COPY.listLabel(COPY.clubShelf) });
    fireEvent.click(screen.getAllByRole("button", { name: COPY.add })[0]);
    return screen.findByRole("dialog", { name: COPY.addTitle });
  }

  it("fills minutes from hours, says them back, and works out the saving as it is typed", async () => {
    stubFetch(routes());
    renderPage(<AdminPackagesPage />);
    const dialog = await openAdd();

    fireEvent.click(within(dialog).getByRole("button", { name: COPY.hoursChip(2) }));
    expect(within(dialog).getByLabelText(COPY.minutesLabel)).toHaveValue("120");
    expect(within(dialog).getByText(COPY.minutesEcho(120))).toHaveTextContent("= 2 h");
    fireEvent.change(within(dialog).getByLabelText(COPY.priceLabel), { target: { value: "220" } });
    const preview = dialog.querySelector("[data-package-preview]")!;
    expect(preview).toHaveTextContent(COPY.perHour(110));
    expect(preview).toHaveTextContent("Saves R20.00 (8%) against 1 hour (R120.00).");
  });

  it("refuses a fraction of a minute and a price below a cent at the field, and sends nothing", async () => {
    const stub = stubFetch(routes([{ method: "POST", path: "/api/v1/admin/packages", status: 201, body: adminPackage() }]));
    renderPage(<AdminPackagesPage />);
    const dialog = await openAdd();

    fireEvent.change(within(dialog).getByLabelText(COPY.nameLabel), { target: { value: "Odd" } });
    fireEvent.change(within(dialog).getByLabelText(COPY.minutesLabel), { target: { value: "30.5" } });
    fireEvent.change(within(dialog).getByLabelText(COPY.priceLabel), { target: { value: "10.005" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.saveNew }));

    expect(within(dialog).getByText("Minutes are whole numbers — leave off the decimals.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(COPY.minutesLabel)).toHaveFocus();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("posts the name, whole minutes, rand and the group's shelf, then shows it at once", async () => {
    const created = adminPackage({ id: "new", name: "League hour", minutes: 60, price_zar: 90, group: { id: "g-league", name: "League" } });
    const stub = stubFetch(routes([{ method: "POST", path: "/api/v1/admin/packages", status: 201, body: created }]));
    renderPage(<AdminPackagesPage />);
    const dialog = await openAdd();

    fireEvent.change(within(dialog).getByLabelText(COPY.nameLabel), { target: { value: "  League hour " } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.hoursChip(1) }));
    fireEvent.change(within(dialog).getByLabelText(COPY.priceLabel), { target: { value: "90" } });
    fireEvent.pointerDown(within(dialog).getByRole("combobox"), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "League" }));
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.saveNew }));

    await waitFor(() => expect(stub.calls.find((c) => c.method === "POST")?.body)
      .toEqual({ name: "League hour", minutes: 60, priceZar: 90, groupId: "g-league", sortOrder: 0 }));
    expect(await screen.findByText(COPY.added("League hour"))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says a taken name in words, keeping the form", async () => {
    stubFetch(routes([{ method: "POST", path: "/api/v1/admin/packages", status: 409, body: { error: "package_name_taken" } }]));
    renderPage(<AdminPackagesPage />);
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(COPY.nameLabel), { target: { value: "5 hours" } });
    fireEvent.change(within(dialog).getByLabelText(COPY.minutesLabel), { target: { value: "300" } });
    fireEvent.change(within(dialog).getByLabelText(COPY.priceLabel), { target: { value: "500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.saveNew }));
    expect(await within(dialog).findByText(new RegExp(COPY.errorCodes.package_name_taken.slice(0, 40)))).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("editing a package", () => {
  it("sends the full replace, never a new shelf, and says the shelf is fixed", async () => {
    const saved = { ...PACKAGES[1], price_zar: 500 };
    const stub = stubFetch(routes([{ method: "PUT", path: "/api/v1/admin/packages/p5", body: saved }]));
    renderPage(<AdminPackagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: COPY.editLabel("5 hours") }));
    const dialog = await screen.findByRole("dialog", { name: COPY.editTitle("5 hours") });
    expect(within(dialog).getByText(COPY.shelfFixed)).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(COPY.priceLabel), { target: { value: "500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.saveEdit }));

    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body)
      .toEqual({ name: "5 hours", minutes: 300, priceZar: 500, sortOrder: 1 }));
    expect(await screen.findByText(COPY.saved("5 hours"))).toBeInTheDocument();
  });

  /** Review round 3's rule for a lost reply: read the record back before saying anything. */
  it("reads the list back when the reply is lost, and says it saved when it did", async () => {
    let price = 550;
    stubFetch([
      { path: "/api/v1/admin/packages", respond: () => ({ packages: PACKAGES.map((p) => (p.id === "p5" ? { ...p, price_zar: price } : p)) }) },
      { path: "/api/v1/admin/member-groups", body: { groups: [LEAGUE] } },
      { method: "PUT", path: "/api/v1/admin/packages/p5", respond: () => { price = 500; return refuse(504, { error: "gateway_timeout" }); } },
    ]);
    renderPage(<AdminPackagesPage />);
    fireEvent.click(await screen.findByRole("button", { name: COPY.editLabel("5 hours") }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(COPY.priceLabel), { target: { value: "500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.saveEdit }));
    expect(await screen.findByText(`${COPY.saved("5 hours")} The club's reply didn't arrive, so we checked its record.`)).toBeInTheDocument();
  });
});

describe("retiring a package", () => {
  it("asks first, then archives it — never a delete — and it leaves the shelf", async () => {
    const stub = stubFetch(routes([{ method: "POST", path: "/api/v1/admin/packages/p10/archive", body: { ...PACKAGES[2], status: "archived" } }]));
    renderPage(<AdminPackagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: COPY.retireLabel("10 hours") }), { detail: 1 });
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/v1/admin/packages/p10/archive")).toBe(true));
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
