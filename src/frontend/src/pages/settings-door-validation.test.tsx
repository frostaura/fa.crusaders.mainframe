import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, renderPage, stubFetch } from "../test/harness";
import { captionOf, control, describedBy, findControl, saveButton } from "../components/settings/testKit";

/**
 * A longer per-test timeout than the 5-second default, for this file only. Each case drives
 * the whole settings page, every section and its save bar in jsdom — 1-2 s on a quiet machine,
 * past 5 s when the suite shares the machine with a parallel backend run or another build
 * (measured 2026-09-28: seven AdminSchedules cases timed out that way with nothing wrong).
 * The assertions are untouched; only the time allowed to render them is.
 */
vi.setConfig({ testTimeout: 20_000 });

/**
 * B5 / C11 / B10 / C12 / A9 — the settings screen's validation, as a person meets it.
 *
 * <p>
 * The defect these pin was not that the form let a bad value through; it was that it did
 * not. An out-of-range door number DISABLED Save, silently: no <code>aria-invalid</code> on
 * the field, no message tied to it, and — because a disabled button is removed from the tab
 * order — the one control that could have explained the state was the one control a keyboard
 * user could not reach. The offending field was two screens above the button it had switched
 * off, and the disabled label measured 2.27:1.
 * </p>
 *
 * <p>
 * So the end state has four parts, and each is a test below: the message lives ON the field
 * (<code>aria-invalid</code> + <code>aria-describedby</code>, without losing the hint that was
 * already there); Save stays in the tab order and says why it will not save; a summary beside
 * Save names each bad field and links back to it; and an emptied number is an EMPTY field
 * rather than a silent zero on the wire.
 * </p>
 *
 * <p>
 * Its own file rather than more cases in <code>AdminSettings.test.tsx</code>, which asks
 * whether the fields are on the screen and whether a save sends them. This asks a different
 * question: what happens when the admin is wrong.
 * </p>
 */

/** The five W1 door keys the fixture does not carry, so the door block renders at all. */
const DOORS = {
  door_log_retention_days: 90,
  door_refusal_spike_count: 8,
  door_refusal_spike_minutes: 20,
  club_contact_phone: "076 226 1390",
  club_contact_email: "squash@example.co.za",
};

const routes = (overrides: Record<string, unknown> = {}) => [
  { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...DOORS, ...overrides } },
  { path: "/api/v1/admin/courts/", body: [] },
  { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
];

// `describedBy` (every id on aria-describedby — a LIST, so the error must JOIN the hint rather
// than replace it), `captionOf` and `saveButton` live in the settings test kit.

describe("AdminSettings — a bad value is tied to the field that holds it", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

  /**
   * B5's first half. The value was refused, Save went dead, and nothing on the field said a
   * word — so the admin's only route to the reason was to notice a button two screens down
   * had changed colour.
   */
  it("marks the offending input invalid and describes it with the reason", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await findControl(/Unlock time/);
    expect(unlock).not.toHaveAttribute("aria-invalid");

    fireEvent.change(unlock, { target: { value: "45" } });

    expect(unlock).toHaveAttribute("aria-invalid", "true");
    expect(describedBy(unlock)).toContain(
      "Unlock time has to be a whole number of seconds between 1 and 30.");
    // And the hint that was already wired to it survives, rather than being displaced by
    // the error — the bound is the context the message is read in.
    expect(describedBy(unlock)).toContain("never holds it open longer than 30 seconds");
  });

  it("clears the invalid mark the moment the value is back in range", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await findControl(/Unlock time/);
    fireEvent.change(unlock, { target: { value: "45" } });
    expect(unlock).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(control(/Unlock time/), { target: { value: "30" } });
    expect(control(/Unlock time/)).not.toHaveAttribute("aria-invalid");
  });

  /** The same treatment on the records numbers, which are three blocks further down. */
  it("marks a door-records number invalid on the field, not only in a block message", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const spike = await findControl(/Refusal spike \(scans\)/);
    fireEvent.change(spike, { target: { value: "1" } });

    expect(spike).toHaveAttribute("aria-invalid", "true");
    expect(describedBy(spike)).toContain("between 3 and 100");
  });
});

describe("AdminSettings — Save stays reachable when it cannot save", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

  /**
   * B5's second half, and the reason it is HIGH rather than MED. `disabled` takes a button
   * out of the tab order entirely, so the control carrying the explanation was the one
   * control a keyboard user could not reach. `aria-disabled` says the same thing to a screen
   * reader and keeps the button focusable.
   */
  it("keeps the button focusable and says why it will not save", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await findControl(/Unlock time/), { target: { value: "45" } });

    const save = saveButton();
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("aria-disabled", "true");
    // Review round 2 (F3-4): the caption is the link and the sentence goes on from it — never
    // "Unlock time (seconds) — Unlock time has to be…".
    expect(describedBy(save)).toContain(
      "Unlock time (seconds) has to be a whole number of seconds between 1 and 30.");
    expect(describedBy(save)).not.toMatch(/Unlock time.*Unlock time/);

    save.focus();
    expect(document.activeElement).toBe(save);
  });

  /**
   * And pressing it does something rather than nothing: it takes the admin to the field that
   * stopped it, and announces that it did. A control that swallows a press with no feedback
   * is indistinguishable, from the person's side, from a broken page.
   */
  it("moves focus to the first bad field on a press, announces it, and sends nothing", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await findControl(/Unlock time/), { target: { value: "45" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(document.activeElement).toBe(control(/Unlock time/)));
    expect(screen.getByText(/Settings cannot be saved yet\. Moved to Unlock time/))
      .toBeInTheDocument();
    expect(stub.calls.find((c) => c.method === "PUT")).toBeUndefined();
  });

  it("saves normally the moment nothing is wrong", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await findControl(/Unlock time/), { target: { value: "7" } });
    const save = saveButton();
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.click(save);

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === "PUT");
      expect(put?.body).toMatchObject({ gateUnlockSeconds: 7 });
    });
  });
});

describe("AdminSettings — the error summary beside Save", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

  /**
   * C11's half of B5: Save is roughly 5 400 px below the field that broke it, so "it is
   * disabled and you will find out why by scrolling" is not a design. The summary names each
   * bad field in the field's OWN words and links back to it.
   */
  it("names every bad field and links back to each one", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await findControl(/Unlock time/);
    fireEvent.change(unlock, { target: { value: "45" } });
    fireEvent.change(control(/Club contact email/), { target: { value: "not-an-email" } });

    expect(screen.getByText(/2 settings need fixing before this can be saved/)).toBeInTheDocument();

    // Named by the caption the field actually carries, read off the DOM rather than restated
    // here — a summary that names a field by a label the screen does not use is a second
    // vocabulary to keep in step.
    const link = screen.getByRole("link", { name: captionOf(unlock) });
    expect(link).toHaveAttribute("href", "#setting-gate-unlock-seconds");

    fireEvent.click(link);
    await waitFor(() =>
      expect(document.activeElement).toBe(control(/Unlock time/)));
  });

  it("says nothing at all while every value is fine", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    expect(screen.queryByText(/need(s)? fixing before this can be saved/)).toBeNull();
  });
});

describe("AdminSettings — an empty number is not zero", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

  /**
   * <b>The wire assertion.</b> `onChange={(e) => set({ x: Number(e.target.value) })}` turns
   * a cleared box into 0, and 0 is a legal-looking number: for `gate_early_entry_minutes` it
   * is IN range and would have been saved. For the rest it trips a bound the admin never
   * typed and was never told about.
   */
  it("holds a cleared door number as empty and never sends the phantom zero", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const retention = await findControl(/Keep door scans for/);
    fireEvent.change(retention, { target: { value: "" } });

    expect(retention).toHaveValue(null);
    expect(retention).toHaveAttribute("aria-invalid", "true");
    expect(describedBy(retention)).toContain("needs a number");
    expect(describedBy(retention)).toContain("an empty box is not the same as 0");

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(document.activeElement).toBe(control(/Keep door scans for/)));

    expect(stub.calls.find((c) => c.method === "PUT")).toBeUndefined();
    // The raw body, not the parsed one: a key that must never have carried 0 is only
    // provably absent in the text that went over the wire.
    expect(stub.calls.some((c) => (c.raw ?? "").includes('"doorLogRetentionDays":0'))).toBe(false);
  });

  /**
   * The field where zero is LEGAL, which is the one the old handler would have silently
   * saved: clearing "Early entry" meant 0, 0 is in range, Save stayed lit, and the club's
   * door quietly stopped letting anybody in early.
   */
  it("refuses to read a cleared early-entry box as the legal value 0", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const early = await findControl(/Early entry/);
    fireEvent.change(early, { target: { value: "" } });

    expect(early).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")).toBeUndefined());

    // And 0 typed deliberately is still a save, because it is a real answer.
    fireEvent.change(control(/Early entry/), { target: { value: "0" } });
    expect(saveButton()).not.toHaveAttribute("aria-disabled");
    fireEvent.click(saveButton());
    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === "PUT");
      expect(put?.body).toMatchObject({ gateEarlyEntryMinutes: 0 });
    });
  });

  /**
   * Every numeric field on the page, not only the five the door programme owns: the shape
   * of the defect is `Number("")`, and it is written at every numeric call site here.
   *
   * <p>
   * Each one is named in the summary by the caption it carries on screen, read off the DOM.
   * That is what pins the page's key→label table to the labels the fields actually render:
   * if the two drift, the summary names a field nobody can see.
   * </p>
   */
  /**
   * <b>Its own timeout, and the number is measured rather than picked.</b>
   *
   * <p>
   * This is the slowest test in the suite by a factor of three — 1 232 ms against a next-worst
   * of 416 ms — and it was the first thing to time out whenever another lane was building
   * beside it. Profiled rather than guessed at: the captions cost 89 ms and the nine
   * `getByRole` lookups 47 ms, while the nine writes cost 860 ms, which is about 95 ms of
   * re-render each. `AdminSettings` is one component holding one state object across nine
   * cards and some thirty fields, so every keystroke re-renders all of it; nine emptied fields
   * is nine of those, and that is the test doing what it is for rather than doing it badly.
   * </p>
   *
   * <p>
   * <b>Three things ruled out, none of them the cause.</b> No fake or shared timers — this
   * file installs none. No short `waitFor` — there is none in this case at all, every
   * assertion here is synchronous. No un-awaited user event — it is `fireEvent`, which is
   * synchronous, not `user-event`. Batching the nine writes into one `act` was tried and
   * returned 12 %: `fireEvent` flushes inside its own `act` per event, so they do not collapse.
   * </p>
   *
   * <p>
   * So the honest fix is headroom, not a rewrite: 15 s is the same test with room for a
   * machine running four lanes at once, and the 5 s default stays where it belongs for
   * everything else.
   * </p>
   */
  it("names each emptied field by its own caption, whichever block it is on", { timeout: 15_000 }, async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    const captions = [
      /Reserve window/, /Penalty \(% of slice price\)/, /Credits per R1 — members/,
      /Court time per member per day/, /Heartbeat interval/, /Alert cooldown/,
      /Unlock time/, /Keep door scans for/, /Keep usage history/,
    ].map((label) => {
      const field = control(label);
      fireEvent.change(field, { target: { value: "" } });
      return captionOf(control(label));
    });

    for (const caption of captions) {
      expect(screen.getByRole("link", { name: caption })).toBeInTheDocument();
    }
    expect(screen.getByText(`${captions.length} settings need fixing before this can be saved:`))
      .toBeInTheDocument();
  });
});

describe("AdminSettings — the club's contact details go on a wall", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

  /**
   * B10 / C12. The two inputs sit outside a `<form>`, so native validation never fires, and
   * the page had none of its own — then the value is printed on the door card that goes up
   * beside the door. A member who cannot get in reads whatever was typed.
   */
  it("refuses an address that is not one, on the field", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const email = await findControl(/Club contact email/);
    fireEvent.change(email, { target: { value: "squash at example" } });

    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(describedBy(email)).toContain("has to look like an address");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("refuses a number with characters no telephone has", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const phone = await findControl(/Club contact number/);
    fireEvent.change(phone, { target: { value: "076 226 1390 🎾" } });

    expect(phone).toHaveAttribute("aria-invalid", "true");
    expect(describedBy(phone)).toContain("digits, spaces");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  });

  /** Empty stays a real answer — the member surfaces have copy for a club with no number. */
  it("still saves an empty contact, which is a club that has none", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await findControl(/Club contact number/), { target: { value: "" } });
    expect(saveButton()).not.toHaveAttribute("aria-disabled");
    fireEvent.click(saveButton());

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === "PUT");
      expect(put?.body).toMatchObject({ clubContactPhone: "" });
    });
  });
});

describe("AdminSettings — deep-linking to one field", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

  /**
   * A9's first half. The doors page's "may not be releasing" signal sends an admin to
   * "change the release under Admin settings", and this page is about 5 400 px tall — so the
   * link landed them at the top and left them to find one number. The hash is the general
   * mechanism, not a special case for this one field.
   */
  it("focuses the unlock field when the page is entered on its hash", async () => {
    window.location.hash = "#setting-gate-unlock-seconds";
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await findControl(/Unlock time/);
    await waitFor(() => expect(document.activeElement).toBe(unlock));
    expect(document.getElementById("setting-gate-unlock-seconds")).toContainElement(unlock);
  });

  it("follows a later hash change to any other setting, not just that one", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await findControl(/Unlock time/);

    window.location.hash = "#setting-door-refusal-spike-count";
    await waitFor(() =>
      expect(document.activeElement).toBe(control(/Refusal spike \(scans\)/)));
  });

  it("ignores a hash that names no setting rather than throwing", async () => {
    window.location.hash = "#setting-not-a-real-key";
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await findControl(/Unlock time/);
    expect(document.activeElement).not.toBe(unlock);
  });
});

describe("AdminSettings — the words an admin reads", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

  /**
   * A9's second half. An admin here is a club volunteer. "Tenant" is our word for the row in
   * our database; nobody at the club has ever used it, and it appears on the first line of
   * the screen.
   */
  it("calls the club a club", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    expect(screen.getByText(/Court schedule, booking limits/)).toHaveTextContent("for this club.");
    expect(document.body.textContent).not.toMatch(/tenant/i);
  });

  /** "Picks a change up on their next heartbeat" is a protocol detail wearing a sentence. */
  it("says when a board picks a change up without naming the protocol", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    expect(document.body.textContent).not.toMatch(/next heartbeat/i);
    expect(screen.getByText(/How the doors behave/)).toHaveTextContent("the next time it calls in");
  });
});
