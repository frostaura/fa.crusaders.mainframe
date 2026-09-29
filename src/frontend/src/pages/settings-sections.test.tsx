import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Link, Route, Routes } from "react-router-dom";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, renderPage, stubFetch } from "../test/harness";
import {
  choose, control, findControl, querySaveButton, saveButton, sectionTrigger,
} from "../components/settings/testKit";
import { SETTINGS_SECTIONS } from "../lib/settingsSchema";
import { SETTINGS_COPY, SETTINGS_INTRO_KEY } from "../lib/settingsCopy";

/**
 * A longer per-test timeout than the 5-second default, for this file only. Each case drives
 * the whole settings page, every section and its save bar in jsdom — 1-2 s on a quiet machine,
 * past 5 s when the suite shares the machine with a parallel backend run or another build
 * (measured 2026-09-28: seven AdminSchedules cases timed out that way with nothing wrong).
 * The assertions are untouched; only the time allowed to render them is.
 */
vi.setConfig({ testTimeout: 20_000 });

/**
 * The settings screen as a DOCUMENT rather than as a form (C12–C14), and the R13 rebuild that
 * made it navigable: ten sections that open and close, a search, live summaries, "unsaved"
 * marks, a save bar that appears when there is something to save, and a guard on leaving.
 */
const routes = (over: Record<string, unknown> = {}) => [
  { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...over } },
  { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
];

afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });
beforeEach(() => window.localStorage.removeItem(SETTINGS_INTRO_KEY));

describe("the settings screen as a document", () => {
  /**
   * C14, as R13 answers it. Reviewer C counted SEVENTY-SIX tab stops from the top of the page to
   * the first door setting. The jump nav that fixed it is retired: every section is now a header
   * button at the top level of one accordion, closed by default, so the door settings are one
   * stop per section away — and each header is a real h2, so a screen reader lists them too.
   */
  it("names every section by a heading whose button opens it", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await screen.findByRole("heading", { name: "Bookings" });
    for (const section of SETTINGS_SECTIONS) {
      const heading = screen.getByRole("heading", { name: section.title, level: 2 });
      const trigger = within(heading).getByRole("button", { name: section.title });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
    // Exactly one header button per section: nothing else on the page poses as one.
    expect(screen.getAllByRole("button", { expanded: false }).filter((b) => b.closest("h2")))
      .toHaveLength(SETTINGS_SECTIONS.length);
  });

  it("opens a section to its fields, and its region is named by the section", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Door gates" }));
    expect(sectionTrigger("Door gates")).toHaveAttribute("aria-expanded", "true");
    const region = screen.getByRole("region", { name: "Door gates" });
    expect(within(region).getByLabelText(/Unlock time/, { selector: "input" })).toBeInTheDocument();
    // The others stay shut — the page opens on ten one-line answers, not seventy fields.
    expect(sectionTrigger("Bookings")).toHaveAttribute("aria-expanded", "false");
  });

  /** "Open all" and "Close all" — for the admin who does want the whole document. */
  it("opens and closes every section at once", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.click(await screen.findByRole("button", { name: SETTINGS_COPY.expandAll }));
    for (const section of SETTINGS_SECTIONS) {
      expect(sectionTrigger(section.title)).toHaveAttribute("aria-expanded", "true");
    }
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_COPY.collapseAll }));
    expect(sectionTrigger("Door gates")).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * C12. A refused field was marked by `aria-invalid` and nothing else, and the complaint was
   * read when a screen reader ARRIVED at the field, never when the value went bad.
   */
  it("marks a refused field and says so when the person leaves it", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await findControl(/Unlock time/);
    fireEvent.change(unlock, { target: { value: "400" } });

    // The boundary says something is wrong: `aria-invalid` paints the danger edge, and a ring
    // makes it more than a one-pixel colour change.
    expect(unlock).toHaveAttribute("aria-invalid", "true");
    expect(unlock.className).toContain("ring-danger-strong");

    // A shape beside the words — colour alone is never the signal (SC 1.4.1).
    const field = unlock.closest("[data-invalid]")!;
    expect(field.querySelector("[data-slot='field-error'] svg")).toBeTruthy();

    // Nothing announced while the answer is half typed…
    const live = field.querySelector("[aria-live='polite']")!;
    expect(live.textContent).toBe("");
    // …and the complaint, named by its field, when the person moves on.
    fireEvent.blur(unlock, { relatedTarget: document.body });
    await waitFor(() => expect(live.textContent).toContain("Unlock time (seconds)"));
    expect(live.textContent).toContain("between 1 and 30");

    // A message cannot outlive the mistake it is about.
    fireEvent.change(unlock, { target: { value: "3" } });
    expect(live.textContent).toBe("");
  });

  /** C13. The derived horizon sentence says which fields it was read from, and follows the policy. */
  it("says which fields the door horizon was read from, and follows the policy picker", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const openBasis = await screen.findByText(/it comes from/);
    expect(openBasis).toHaveTextContent("Offline roster reach (minutes)");
    expect(openBasis).toHaveTextContent("Lights on this early (minutes before a booking)");
    expect(openBasis).toHaveTextContent("Court boxes & identification");
    expect(openBasis).toHaveTextContent("only sets a floor (currently 30)");
    expect(openBasis).toHaveTextContent("a member's own code opens a door whenever their membership is active");

    choose(/Who may open a door/, "Only a member with a booking");
    const strictBasis = screen.getByText(/on this block and nothing else/);
    expect(strictBasis).toHaveTextContent("Early entry (minutes before a booking)");
    expect(strictBasis).not.toHaveTextContent("Offline roster reach");
    expect(strictBasis).not.toHaveTextContent("a member's own code");
  });

  it("switches which field it names once early entry becomes the floor that wins", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await screen.findByText(/it comes from/);
    fireEvent.change(control(/Early entry/), { target: { value: "200" } });

    const basis = screen.getByText(/it comes from/);
    expect(basis).toHaveTextContent("Early entry (minutes before a booking)");
    expect(basis).toHaveTextContent("would give 130");
    expect(basis).toHaveTextContent("never opens less early than this floor");
  });

  it("says when the four-hour cap is what stopped the number", async () => {
    stubFetch(routes({ roster_window_minutes: 1440, activation_cue_window_minutes: 1440 }));
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText(/which is the cap, so the answer stops there/)).toBeInTheDocument();
  });
});

describe("R13 — summaries, unsaved marks and the save bar", () => {
  /** Collapsed, a section still answers: its header carries a live one-line summary. */
  it("summarises each section from the working copy, and follows an edit", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const doors = await screen.findByRole("button", { name: "Door gates" });
    expect(doors).toHaveAccessibleDescription(/Any member in good standing · lock released 15 s/);
    expect(sectionTrigger("Bookings")).toHaveAccessibleDescription(/15-min slices · 14 days ahead · 60 min a day each/);
    expect(sectionTrigger("Cancellations & no-shows")).toHaveAccessibleDescription(/30% penalty inside 15 min/);

    fireEvent.change(control(/Unlock time/), { target: { value: "20" } });
    expect(doors).toHaveAccessibleDescription(/lock released 20 s/);
  });

  it("shows no save bar until something changes, then counts the changes and marks the section", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    expect(querySaveButton()).toBeNull();
    expect(sectionTrigger("Door gates")).not.toHaveAccessibleDescription(/Unsaved changes/);

    fireEvent.change(control(/Unlock time/), { target: { value: "20" } });
    fireEvent.change(control(/Walk-up maximum/), { target: { value: "60" } });
    fireEvent.change(control(/Grace window/), { target: { value: "10" } });

    expect(screen.getByText(SETTINGS_COPY.changes(3))).toBeInTheDocument();
    expect(sectionTrigger("Door gates")).toHaveAccessibleDescription(/Unsaved changes/);
    expect(sectionTrigger("Court boxes & identification")).toHaveAccessibleDescription(/Unsaved changes/);
    expect(sectionTrigger("Bookings")).not.toHaveAccessibleDescription(/Unsaved changes/);

    // Put back by hand: not a change any more.
    fireEvent.change(control(/Grace window/), { target: { value: "5" } });
    expect(screen.getByText(SETTINGS_COPY.changes(2))).toBeInTheDocument();
  });

  it("saves, and the bar goes away once what was sent is the saved copy", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await findControl(/Unlock time/), { target: { value: "20" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(await screen.findByText(SETTINGS_COPY.saved)).toBeInTheDocument();
    await waitFor(() => expect(querySaveButton()).toBeNull());
    expect(sectionTrigger("Door gates")).not.toHaveAccessibleDescription(/Unsaved changes/);
  });

  /** Discard asks first — it throws work away — and then puts every field back as saved. */
  it("discards every change after a confirm, and sends nothing", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await findControl(/Unlock time/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_COPY.discard }));
    const dialog = await screen.findByRole("dialog", { name: SETTINGS_COPY.discardTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: SETTINGS_COPY.discardConfirm }));

    await waitFor(() => expect(control(/Unlock time/)).toHaveValue(15));
    expect(querySaveButton()).toBeNull();
    expect(stub.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  /** A failed read is a failed read — never "Loading settings…" for ever, never an empty form. */
  it("says the read failed and offers a retry rather than a form of nothing", async () => {
    // A 408, not a 5xx: `StateBlock` rightly offers no retry for a deployment fault.
    stubFetch([{ path: "/api/v1/admin/settings/", status: 408, body: { error: "timeout" } }]);
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Door gates" })).toBeNull();
  });
});

describe("R13 — search", () => {
  it("filters to the settings that match, opens their sections and marks the words", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    fireEvent.change(screen.getByRole("searchbox", { name: SETTINGS_COPY.searchLabel }), { target: { value: "unlock" } });

    // Door gates opens by itself, showing the one setting that answers — and the word is marked.
    expect(sectionTrigger("Door gates")).toHaveAttribute("aria-expanded", "true");
    const unlock = control(/Unlock time/);
    expect(unlock.closest("[data-setting]")).not.toHaveAttribute("hidden");
    expect(document.querySelector("label mark")?.textContent?.toLowerCase()).toBe("unlock");
    expect(control(/Early entry/).closest("[data-setting]")).toHaveAttribute("hidden");
    // Sections with no match leave the page while the search runs.
    expect(screen.queryByRole("button", { name: "Bookings" })).toBeNull();
    expect(screen.getByText(SETTINGS_COPY.matchCount(1))).toBeInTheDocument();
  });

  it("finds a setting by what it does, not only by its name", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    fireEvent.change(screen.getByRole("searchbox", { name: SETTINGS_COPY.searchLabel }), { target: { value: "no-show" } });
    expect(control(/Grace window/).closest("[data-setting]")).not.toHaveAttribute("hidden");
  });

  it("opens the advanced disclosure when the match is behind it", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    fireEvent.change(screen.getByRole("searchbox", { name: SETTINGS_COPY.searchLabel }), { target: { value: "heartbeat" } });
    expect(screen.getByRole("button", { name: SETTINGS_COPY.advancedHide })).toHaveAttribute("aria-expanded", "true");
  });

  it("says so when nothing matches, and Escape clears the search", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await findControl(/Unlock time/);
    const box = screen.getByRole("searchbox", { name: SETTINGS_COPY.searchLabel });
    fireEvent.change(box, { target: { value: "zebra crossing" } });
    expect(screen.getByText(SETTINGS_COPY.noMatches("zebra crossing"))).toBeInTheDocument();

    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("");
    expect(screen.getByRole("button", { name: "Bookings" })).toBeInTheDocument();
  });
});

describe("R13 — guidance and the first visit", () => {
  it("puts the full guidance behind a named (i) and on the control's description", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Door gates" }));
    // Also on the control's description, for a screen reader that never opens the popover.
    expect(control(/Unlock time/)).toHaveAccessibleDescription(/never holds it open longer than 30 seconds/);
    fireEvent.click(screen.getByRole("button", { name: "More about Unlock time (seconds)" }));
    const guidance = await screen.findByRole("dialog", { name: "Unlock time (seconds)" });
    expect(guidance).toHaveTextContent("never holds it open longer than 30 seconds");
  });

  it("explains the page once, and remembers being dismissed", async () => {
    stubFetch(routes());
    const { unmount } = renderPage(<AdminSettingsPage />);

    await screen.findByText(SETTINGS_COPY.introTitle);
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_COPY.introDismiss }));
    expect(screen.queryByText(SETTINGS_COPY.introTitle)).toBeNull();
    unmount();

    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await findControl(/Unlock time/);
    expect(screen.queryByText(SETTINGS_COPY.introTitle)).toBeNull();
  });

  it("says group rates are set on each group, and links there (D2)", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Credits & top-ups" }));
    const credits = screen.getByRole("region", { name: "Credits & top-ups" });
    expect(within(credits).getByText(SETTINGS_COPY.groupRatesNote)).toBeInTheDocument();
    expect(within(credits).getByRole("link", { name: SETTINGS_COPY.groupRatesLink })).toHaveAttribute("href", "/admin/groups");
    // The "moving to Groups" interim notice is gone: the move happened.
    expect(within(credits).queryByText(/moving to Groups/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Credits & top-ups" })).not.toHaveTextContent(/league/i);
  });
});

describe("R13 — leaving with unsaved changes", () => {
  function WithElsewhere() {
    return (
      <Routes>
        <Route path="/admin/settings" element={<><Link to="/wallet">Wallet</Link><AdminSettingsPage /></>} />
        <Route path="/wallet" element={<h1>Wallet page</h1>} />
      </Routes>
    );
  }

  it("asks before a link takes the admin away from unsaved changes", async () => {
    stubFetch(routes());
    renderPage(<WithElsewhere />, { initialEntries: ["/admin/settings"] });

    fireEvent.change(await findControl(/Unlock time/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("link", { name: "Wallet" }));

    const dialog = await screen.findByRole("dialog", { name: SETTINGS_COPY.leaveTitle });
    expect(dialog).toHaveTextContent("1 unsaved change");
    expect(screen.queryByText("Wallet page")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: SETTINGS_COPY.leaveConfirm }));
    expect(await screen.findByText("Wallet page")).toBeInTheDocument();
  });

  it("lets a link through untouched when there is nothing to lose", async () => {
    stubFetch(routes());
    renderPage(<WithElsewhere />, { initialEntries: ["/admin/settings"] });

    await findControl(/Unlock time/);
    fireEvent.click(screen.getByRole("link", { name: "Wallet" }));
    expect(await screen.findByText("Wallet page")).toBeInTheDocument();
  });

  it("asks the browser to hold a tab close while there are changes", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await findControl(/Unlock time/), { target: { value: "20" } });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("R13 — deep links to a section", () => {
  it("opens the section a #settings-<id> hash names and focuses its header", async () => {
    window.location.hash = "#settings-doors";
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const trigger = await screen.findByRole("button", { name: "Door gates" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a closed section, and its advanced disclosure, to reach a #setting-<key> field", async () => {
    window.location.hash = "#setting-heartbeat-seconds";
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const heartbeat = await findControl(/Heartbeat interval/);
    await waitFor(() => expect(heartbeat).toHaveFocus());
    expect(sectionTrigger("Court boxes & identification")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: SETTINGS_COPY.advancedHide })).toHaveAttribute("aria-expanded", "true");
  });
});
