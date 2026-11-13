import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { ProfileProvider } from "@/lib/profile";
import { CHECKLIST, CODE_HELP, GUIDE_FROM_CODE } from "@/lib/onboardingCopy";
import { codeUseLine } from "@/lib/myCodeCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { CodeHelp } from "./CodeHelp";

/**
 * Go-live BM-13 — My Code's help was a lone "?" named "Help with your code" that opened "Finish
 * setting up 0 of 4 done". It is a worded button now, and what it opens leads with how the code is
 * used; the setup list a member still has comes after it.
 */

function member() {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "thandi@review.test", is_admin: false, tenant_slug: "crusaders", full_name: "Thandi Probe", membership_number: "M-9", photo_url: null, status: "active" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
  ]);
}

const show = (props: { doors: boolean; signedOut: boolean }) =>
  renderPage(<ProfileProvider><CodeHelp {...props} /></ProfileProvider>, { initialEntries: ["/my-code"] });

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

describe("My Code's help (BM-13)", () => {
  it("is a worded button, and opens with how the code is used before the setup list", async () => {
    member();
    show({ doors: true, signedOut: false });
    const trigger = screen.getByRole("button", { name: CODE_HELP.label });
    expect(trigger).toHaveTextContent(CODE_HELP.label);
    fireEvent.click(trigger);
    const pane = await screen.findByRole("dialog", { name: CODE_HELP.heading });
    const checklist = await within(pane).findByRole("region", { name: CHECKLIST.title });
    const use = within(pane).getByText(codeUseLine(true));
    // The use line comes first in the pane; the checklist is the second thing in it.
    expect(use.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(pane).getByRole("link", { name: GUIDE_FROM_CODE })).toBeInTheDocument();
  });

  it("signed out it holds the use line and the guide, and no setup list", async () => {
    member();
    show({ doors: false, signedOut: true });
    fireEvent.click(screen.getByRole("button", { name: CODE_HELP.label }));
    const pane = await screen.findByRole("dialog", { name: CODE_HELP.heading });
    expect(within(pane).getByText(codeUseLine(false))).toBeInTheDocument();
    expect(within(pane).queryByRole("region", { name: CHECKLIST.title })).toBeNull();
  });
});
