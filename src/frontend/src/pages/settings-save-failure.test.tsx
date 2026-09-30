import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { findControl, saveButton } from "../components/settings/testKit";
import { SETTINGS_COPY } from "../lib/settingsCopy";
import { settingDef } from "../lib/settingsSchema";
import { keepSettingsDraft, noteSettingsDraftSessionEnded } from "../lib/settingsDraftStore";
import { rateLimitedSentence } from "../lib/errors";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Review round 1, F3.15 — a failed save and a session that ends during one.
 *
 * <p>
 * A refusal was a toast that faded in eight seconds and could read "validation failed"; a session
 * that ended mid-save threw every edit away. The refusal is now a banner that names the field,
 * offers a way to it and says what to do; the edits are kept for this tab across a sign-in.
 * </p>
 */
const USER = "44444444-4444-4444-4444-444444444444";

function routes(put: Partial<StubRoute> = {}): StubRoute[] {
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    { path: "/api/v1/admin/courts/", body: [] },
    { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true }, ...put },
  ];
}

beforeEach(() => { signIn({ isAdmin: true }); window.sessionStorage.clear(); });
afterEach(() => { signOut(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

async function changeAhead(value: string) {
  fireEvent.change(await findControl(/Reserve window/), { target: { value } });
}

describe("a refused save stays on the page and says what to do", () => {
  it("names the field a refusal is about, with a way to it and the next step", async () => {
    const stub = stubFetch(routes({ status: 400, body: { error: "advance_booking_days_out_of_range" } }));
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));

    expect(await screen.findByText(SETTINGS_COPY.saveNotSaved)).toBeInTheDocument();
    const label = settingDef("advance_booking_days")!.label;
    expect(screen.getByText(SETTINGS_COPY.saveRefusedField(label))).toBeInTheDocument();
    // The reason itself, said once — at the field.
    expect(screen.getAllByText(/outside what the club’s system accepts/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: SETTINGS_COPY.saveGoTo(label) })).toBeInTheDocument();
  });

  it("never prints a raw token for a refusal that names no field", async () => {
    stubFetch(routes({ status: 400, body: { error: "validation_failed" } }));
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());

    expect(await screen.findByText(SETTINGS_COPY.saveRefusedUnnamed)).toBeInTheDocument();
    expect(screen.queryByText("validation failed")).toBeNull();
  });
});

describe("a session that ends during a save keeps the edits", () => {
  it("mirrors an edit for this tab", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    await waitFor(() => expect(window.sessionStorage.getItem(`crusaders.settings.draft.${USER}`)).toContain(`"advance_booking_days":30`));
  });

  it("brings the kept edits back after signing in again, and says they are not saved", async () => {
    keepSettingsDraft(USER, SETTINGS_FIXTURE as never, { ...SETTINGS_FIXTURE, advance_booking_days: 30 } as never);
    noteSettingsDraftSessionEnded(USER);
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText(SETTINGS_COPY.draftRestored)).toBeInTheDocument();
    expect(await findControl(/Reserve window/)).toHaveValue(30);
  });

  it("drops kept edits made over settings that have since changed", async () => {
    keepSettingsDraft(USER, { ...SETTINGS_FIXTURE, advance_booking_days: 20 } as never, { ...SETTINGS_FIXTURE, advance_booking_days: 30 } as never);
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    expect(await findControl(/Reserve window/)).toHaveValue(SETTINGS_FIXTURE.advance_booking_days);
    expect(screen.queryByText(SETTINGS_COPY.draftRestored)).toBeNull();
    expect(screen.queryByText(SETTINGS_COPY.draftRestoredEarlier)).toBeNull();
  });

  /** Review round 3, A-9: a plain reload restored the draft and claimed a sign-in that never happened. */
  it("claims no sign-in when the edits were kept across a plain reload", async () => {
    keepSettingsDraft(USER, SETTINGS_FIXTURE as never, { ...SETTINGS_FIXTURE, advance_booking_days: 30 } as never);
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText(SETTINGS_COPY.draftRestoredEarlier)).toBeInTheDocument();
    expect(screen.queryByText(SETTINGS_COPY.draftRestored)).toBeNull();
  });

  it("marks the kept edits as waiting for a sign-in when a save meets an ended session", async () => {
    stubFetch([...routes({ status: 401, body: { error: "unauthorized" } }), { method: "POST", path: "/api/v1/auth/refresh", status: 401, body: {} }]);
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());
    await waitFor(() => expect(window.sessionStorage.getItem(`crusaders.settings.draft.${USER}`)).toContain(`"afterSessionEnd":true`));
  });
});

/** Review round 3, A-12: a 429 said "fix what is named" with nothing named. */
describe("the club's rate limit on a save", () => {
  it("says it is busy and nothing was saved, and asks for no fix", async () => {
    stubFetch(routes({ status: 429, body: { error: "rate_limited", retry_after_seconds: 12 } }));
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());

    expect(await screen.findByText(SETTINGS_COPY.saveRateLimited(rateLimitedSentence(12)))).toBeInTheDocument();
    expect(screen.queryByText(SETTINGS_COPY.saveNotSaved)).toBeNull();
  });
});

/**
 * Review round 2, F3-4 — measured in a real browser before it was fixed: the kept draft came back,
 * then a SECOND settings read (StrictMode's double effect in development; a retry in production)
 * landed 300 ms later, replaced the working copy, and the mirror erased the kept draft.
 */
describe("kept edits survive the page's own second read (F3-4)", () => {
  /** Delay every settings GET after the first, so it lands after the restore has happened. */
  function delaySecondRead(ms: number) {
    const inner = globalThis.fetch;
    let reads = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const isRead = String(input).startsWith("/api/v1/admin/settings/") && (init?.method ?? "GET") === "GET";
      if (isRead && ++reads > 1) return new Promise((r) => { setTimeout(() => r(inner(input, init)), ms); });
      return inner(input, init);
    });
  }

  it("keeps the restored edits and the kept copy when a second read lands afterwards", async () => {
    keepSettingsDraft(USER, SETTINGS_FIXTURE as never, { ...SETTINGS_FIXTURE, advance_booking_days: 30 } as never);
    stubFetch(routes());
    delaySecondRead(150);
    renderPage(<AdminSettingsPage />, { reactStrictMode: true });

    expect(await screen.findByText(SETTINGS_COPY.draftRestoredEarlier)).toBeInTheDocument();
    await new Promise((r) => { setTimeout(r, 400); });
    expect(await findControl(/Reserve window/)).toHaveValue(30);
    expect(window.sessionStorage.getItem(`crusaders.settings.draft.${USER}`)).toContain(`"advance_booking_days":30`);
  });

  it("brings an edit back even when somebody saved a DIFFERENT setting meanwhile", async () => {
    keepSettingsDraft(USER, { ...SETTINGS_FIXTURE, penalty_pct: 25 } as never, { ...SETTINGS_FIXTURE, penalty_pct: 25, advance_booking_days: 30 } as never);
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText(SETTINGS_COPY.draftRestoredEarlier)).toBeInTheDocument();
    expect(await findControl(/Reserve window/)).toHaveValue(30);
  });

  it("says which kept edit was not brought back because someone saved that very setting", async () => {
    keepSettingsDraft(USER, { ...SETTINGS_FIXTURE, advance_booking_days: 20 } as never, { ...SETTINGS_FIXTURE, advance_booking_days: 30 } as never);
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const label = settingDef("advance_booking_days")!.label;
    expect(await screen.findByText(SETTINGS_COPY.draftDropped([label]))).toBeInTheDocument();
    expect(await findControl(/Reserve window/)).toHaveValue(SETTINGS_FIXTURE.advance_booking_days);
  });
});

/**
 * F3-4: after a 5xx the banner said "Nothing was saved… fix what is named" — nothing was named,
 * and a 504 may well have saved. A lost reply now re-reads the club and says what it found.
 */
describe("a save whose reply was lost is asked about (F3-4)", () => {
  it("says it saved when the club's settings now hold the change", async () => {
    let stored: Record<string, unknown> = { ...SETTINGS_FIXTURE };
    stubFetch([
      ...routes().filter((r) => r.path !== "/api/v1/admin/settings/"),
      { path: "/api/v1/admin/settings/", respond: () => stored },
      {
        method: "PUT", path: "/api/v1/admin/settings/",
        respond: (req) => {
          stored = { ...stored, advance_booking_days: (req.body as Record<string, unknown>).advanceBookingDays ?? (req.body as Record<string, unknown>).advance_booking_days };
          return refuse(504, { error: "gateway_timeout" });
        },
      },
    ]);
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());

    expect(await screen.findByText(SETTINGS_COPY.savedAfterLostReply)).toBeInTheDocument();
    expect(screen.queryByText(SETTINGS_COPY.saveNotSaved)).toBeNull();
  });

  it("says it did not arrive — without 'fix what is named' — when the club is unchanged", async () => {
    stubFetch(routes({ status: 503, body: { error: "server_error" } }));
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());

    expect(await screen.findByText(SETTINGS_COPY.saveDidNotArrive)).toBeInTheDocument();
    expect(screen.queryByText(SETTINGS_COPY.saveNotSaved)).toBeNull();
  });

  it("says it is not known when the club cannot be read either", async () => {
    let reads = 0;
    stubFetch([
      ...routes({ status: 502, body: { error: "bad_gateway" } }).filter((r) => !(r.path === "/api/v1/admin/settings/" && !r.method)),
      { path: "/api/v1/admin/settings/", respond: () => (++reads > 1 ? refuse(503, { error: "down" }) : SETTINGS_FIXTURE) },
    ]);
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());

    expect(await screen.findByText(SETTINGS_COPY.saveUnknown)).toBeInTheDocument();
  });

  it("brings the banner into view and gives it focus — it sits far above the floating bar", async () => {
    stubFetch(routes({ status: 400, body: { error: "advance_booking_days_out_of_range" } }));
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    fireEvent.click(saveButton());

    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-save-failure"));
    expect(document.activeElement).toHaveTextContent(SETTINGS_COPY.saveNotSaved);
  });
});

describe("the save bar never covers the field being typed in (F3.23)", () => {
  it("pads the page's scroll edge while it floats, and stops when it goes", async () => {
    stubFetch(routes());
    const { unmount } = renderPage(<AdminSettingsPage />);
    expect(document.documentElement.style.scrollPaddingBottom).toBe("");
    await changeAhead("30");
    await waitFor(() => expect(document.documentElement.style.scrollPaddingBottom).toMatch(/px$/));
    unmount();
    expect(document.documentElement.style.scrollPaddingBottom).toBe("");
  });
});

describe("a successful save keeps the keyboard somewhere (F4.7, settings half)", () => {
  it("lands focus on a status saying it saved, never on <body>", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await changeAhead("30");
    const save = saveButton();
    save.focus();
    fireEvent.click(save);
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-save-landing"));
    expect(document.activeElement).toHaveTextContent(SETTINGS_COPY.saved);
    // Review round 2 (F3-4): a VISIBLE status, not a 1×1 screen-reader line that empties itself.
    expect(document.activeElement).not.toHaveClass("sr-only");
    expect(document.activeElement?.closest(".sr-only")).toBeNull();
    // And it stays until the next edit.
    await new Promise((r) => { setTimeout(r, 3500); });
    expect(screen.getByText(SETTINGS_COPY.saved)).toBeInTheDocument();
    await changeAhead("31");
    await waitFor(() => expect(screen.queryByText(SETTINGS_COPY.saved)).toBeNull());
  });
});
