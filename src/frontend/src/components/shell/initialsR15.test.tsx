import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import Layout from "./AppShell";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PlayerAvatar } from "@/components/play/PlayerAvatar";
import { MemberCodePass } from "@/components/member-code/MemberCodePass";
import { initialsOf as membersInitials } from "@/components/members/membersModel";
import { ProfileProvider } from "@/lib/profile";
import { ThemeProvider } from "@/lib/theme";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";

/**
 * R15 J15-6 — every avatar draws "Roberta Smithson Jr." as RS, the court box's rule, never RJ.
 */

const NAME = "Roberta Smithson Jr.";

afterEach(() => { signOut(); localStorage.clear(); });

describe("one initials rule on every avatar (R15 J15-6)", () => {
  it("ui/avatar's named fallback", () => {
    render(<Avatar size={32}><AvatarFallback name={NAME} /></Avatar>);
    expect(document.querySelector("[data-slot=avatar-fallback]")).toHaveTextContent(/^RS$/);
  });

  it("a player's face", () => {
    render(<PlayerAvatar name={NAME} photo={null} />);
    expect(document.querySelector("[data-slot=avatar-fallback]")).toHaveTextContent(/^RS$/);
  });

  it("the pass", () => {
    render(<MemberCodePass token={null} remainingMs={0} offline={false} memberName={NAME} photoUrl={null} onOpenFullScreen={() => {}} />);
    expect(document.querySelector("[data-slot=avatar-fallback]")).toHaveTextContent(/^RS$/);
  });

  it("the members list and picker", () => {
    expect(membersInitials(NAME)).toBe("RS");
  });

  it("the account menu's avatar in the bar", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: 90, entries: [], count: 0 } },
      { path: "/api/v1/me/profile", body: {
        user_id: whoami.user_id, email: "roberta@review.test", is_admin: false, tenant_slug: "crusaders",
        full_name: NAME, membership_number: "M-1", photo_url: null, status: "active",
      } },
    ]);
    renderPage(
      <ThemeProvider><ProfileProvider><Routes><Route element={<Layout />}><Route path="/my-code" element={<h1>Your code</h1>} /></Route></Routes></ProfileProvider></ThemeProvider>,
      { initialEntries: ["/my-code"] },
    );
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    await waitFor(() => expect(trigger.querySelector("[data-slot=avatar-fallback]")).toHaveTextContent(/^RS$/));
  });
});
