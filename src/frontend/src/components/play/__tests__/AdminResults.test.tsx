import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderPage, signOut } from "@/test/harness";
import AdminResultsPage from "@/pages/admin/AdminResults";
import { MemberPlayCard } from "@/components/play/admin/MemberPlayCard";
import { ADMIN_RESULTS, MEMBER_PLAY_CARD, PLAY_KIND_WORD } from "@/lib/playCopy";
import { KIND_ICON, kindWord } from "@/components/inbox/notificationKinds";
import { ADMIN_CHANGE_AREAS } from "@/lib/adminApi";
import { adminResult, result, serve, RESULT_ID, SAM } from "./playKit";

/**
 * The admin's Match results (§9.4): the disputes first with their notes, the other tabs on
 * demand, and the two decisions — each with a required reason, sent as the server's body — plus
 * the member Overview's counts-only Play card and the inbox's five play kinds.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const LIST = "/api/v1/admin/play/results";
const page = (items: unknown[], count = items.length) => ({ items, next_cursor: null, count });

function routes(extra: Parameters<typeof serve>[0] = []) {
  return serve([
    { path: `${LIST}?status=disputed`, body: page([adminResult()]) },
    { path: `${LIST}?status=pending`, body: page([adminResult({ status: "pending", disputed_by: null, dispute_note: null })]) },
    { path: `${LIST}?status=voided`, body: page([]) },
    { path: `${LIST}/disputed/count`, body: { count: 1 } },
    ...extra,
  ], { admin: true });
}

describe("the list", () => {
  it("opens on the disputes, each with the lineup, score, who recorded, who disputed and the note", async () => {
    routes();
    renderPage(<AdminResultsPage />);
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-admin-result="${RESULT_ID}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(screen.getByRole("tab", { name: ADMIN_RESULTS.tabs.disputed })).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveTextContent("Court 1");
    expect(row).toHaveTextContent(ADMIN_RESULTS.recordedBy("Nomsa Khumalo"));
    expect(row).toHaveTextContent(ADMIN_RESULTS.disputedBy("Sam Petersen"));
    expect(row.querySelector("[data-dispute-note]")).toHaveTextContent("It was 3–2, not 3–1.");
    expect(within(row).getByRole("table")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: ADMIN_RESULTS.keep })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: ADMIN_RESULTS.remove })).toBeInTheDocument();
  });

  it("reads another tab when asked; a waiting row has no Keep result", async () => {
    const stub = routes();
    renderPage(<AdminResultsPage />);
    await screen.findByRole("button", { name: ADMIN_RESULTS.keep });
    const tab = screen.getByRole("tab", { name: ADMIN_RESULTS.tabs.pending });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith(`${LIST}?status=pending`))).toBe(true));
    expect(await screen.findByRole("button", { name: ADMIN_RESULTS.remove })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ADMIN_RESULTS.keep })).toBeNull();
  });

  it("an empty tab says so, in its own words", async () => {
    routes();
    renderPage(<AdminResultsPage />);
    await screen.findByRole("button", { name: ADMIN_RESULTS.keep });
    const tab = screen.getByRole("tab", { name: ADMIN_RESULTS.tabs.voided });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(await screen.findByText(ADMIN_RESULTS.emptyTitle.voided)).toBeInTheDocument();
  });
});

describe("the decisions", () => {
  it("remove needs a reason, sends it, drops the row and re-reads the badge", async () => {
    const stub = routes([{ method: "POST", path: `${LIST}/${RESULT_ID}/void`, body: { ...adminResult(), status: "voided" } }]);
    renderPage(<AdminResultsPage />);
    fireEvent.click(await screen.findByRole("button", { name: ADMIN_RESULTS.remove }));
    const dialog = screen.getByRole("dialog", { name: ADMIN_RESULTS.removeTitle });
    expect(within(dialog).getByRole("button", { name: ADMIN_RESULTS.removeKeep })).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: ADMIN_RESULTS.remove });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(ADMIN_RESULTS.reasonLabel), { target: { value: "  Both agreed it was 3–2  " } });
    fireEvent.click(confirm);
    await waitFor(() => expect(document.querySelector(`[data-admin-result="${RESULT_ID}"]`)).toBeNull());
    expect(stub.calls.find((c) => c.path.endsWith("/void"))?.body).toEqual({ reason: "Both agreed it was 3–2" });
    expect((await screen.findAllByText(ADMIN_RESULTS.removed)).length).toBeGreaterThan(0);
    await waitFor(() => expect(stub.calls.some((c) => c.path === `${LIST}/disputed/count`)).toBe(true));
  });

  it("keep upholds a disputed result with its reason", async () => {
    const stub = routes([{ method: "POST", path: `${LIST}/${RESULT_ID}/uphold`, body: { ...adminResult(), status: "confirmed" } }]);
    renderPage(<AdminResultsPage />);
    fireEvent.click(await screen.findByRole("button", { name: ADMIN_RESULTS.keep }));
    const dialog = screen.getByRole("dialog", { name: ADMIN_RESULTS.keepTitle });
    fireEvent.change(within(dialog).getByLabelText(ADMIN_RESULTS.reasonLabel), { target: { value: "Score checked with both" } });
    fireEvent.click(within(dialog).getByRole("button", { name: ADMIN_RESULTS.keep }));
    await waitFor(() => expect(stub.calls.find((c) => c.path.endsWith("/uphold"))?.body).toEqual({ reason: "Score checked with both" }));
  });

  it("a refusal stays in the dialog, and the row stays", async () => {
    routes([{ method: "POST", path: `${LIST}/${RESULT_ID}/void`, status: 409, body: { error: "result_not_voidable", status: "withdrawn" } }]);
    renderPage(<AdminResultsPage />);
    fireEvent.click(await screen.findByRole("button", { name: ADMIN_RESULTS.remove }));
    const dialog = screen.getByRole("dialog", { name: ADMIN_RESULTS.removeTitle });
    fireEvent.change(within(dialog).getByLabelText(ADMIN_RESULTS.reasonLabel), { target: { value: "Wrong score" } });
    fireEvent.click(within(dialog).getByRole("button", { name: ADMIN_RESULTS.remove }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(document.querySelector(`[data-admin-result="${RESULT_ID}"]`)).not.toBeNull();
  });
});

describe("the member's Play card", () => {
  it("shows the five counts and links open disputes — and nothing else about the member", async () => {
    serve([{
      path: `/api/v1/admin/members/${SAM}/play`,
      body: {
        sessions_attended: 58, minutes_this_month: 405, minutes_all_time: 2610, current_streak_weeks: 6,
        matches_played: 21, matches_won: 12, matches_lost: 9, open_disputes: 1, badges_earned: 7,
      },
    }], { admin: true });
    renderPage(<MemberPlayCard userId={SAM} />);
    const card = await waitFor(() => {
      const found = document.querySelector("[data-member-play] dl");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card).toHaveTextContent(`${MEMBER_PLAY_CARD.sessions}58`);
    expect(card).toHaveTextContent("6 h 45 min");
    expect(card).toHaveTextContent(MEMBER_PLAY_CARD.streakValue(6));
    expect(card).toHaveTextContent("12–9");
    expect(screen.getByRole("link", { name: new RegExp(MEMBER_PLAY_CARD.openDisputes) })).toHaveAttribute("href", "/admin/results");
    expect(card.textContent).not.toMatch(/Sam|Regular|partner/i);
  });

  it("a failed read is a failure with a retry, never zeros", async () => {
    serve([{ path: `/api/v1/admin/members/${SAM}/play`, respond: () => { throw new TypeError("Failed to fetch"); } }], { admin: true });
    renderPage(<MemberPlayCard userId={SAM} />);
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(document.querySelector("[data-member-play] dl")).toBeNull();
  });
});

describe("the inbox and the change record", () => {
  it("knows every play kind by word and mark", () => {
    for (const kind of Object.keys(PLAY_KIND_WORD)) {
      expect(kindWord(kind), kind).toBe(PLAY_KIND_WORD[kind]);
      expect(KIND_ICON[kind], kind).toBeTruthy();
    }
    expect(Object.keys(PLAY_KIND_WORD).sort()).toEqual([
      "play.badge_earned", "play.result_confirmed", "play.result_disputed", "play.result_to_confirm", "play.result_voided",
    ]);
  });

  it("names the play area on the change record", () => {
    expect(ADMIN_CHANGE_AREAS).toContain("play");
    expect(result().status).toBe("pending");
  });
});
