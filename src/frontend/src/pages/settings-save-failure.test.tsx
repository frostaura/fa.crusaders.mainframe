import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { findControl, saveButton } from "../components/settings/testKit";
import { SETTINGS_COPY } from "../lib/settingsCopy";
import { settingDef } from "../lib/settingsSchema";
import { keepSettingsDraft } from "../lib/settingsDraftStore";

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
  });
});
