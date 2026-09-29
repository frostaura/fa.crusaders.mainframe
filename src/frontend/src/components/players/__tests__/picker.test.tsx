import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { refuse, renderPage, stubFetch, type StubCall } from "@/test/harness";
import { PICKER, PLAYERS_REFUSAL, playersRefusal } from "@/lib/playersCopy";
import { ApiError } from "@/lib/api";
import { PlayerPicker, PlayerPickerDialog, type PickedPlayer } from "../PlayerPicker";

/**
 * The player picker (P11, D11–D13): each tab, the directory's two-character floor and 300 ms
 * debounce, its rate-limit refusal as a sentence, the optimistic star, and "already added". Every
 * query goes through `PICKER` so a wording change is one edit.
 */

const SAM = { user_id: "sam", name: "Sam Petersen", photo_url: null };
const ALEX = { user_id: "alex", name: "Alex Naidoo", photo_url: null };
const JO = { user_id: "jo", name: "Jo van Wyk", photo_url: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function routes(extra: Parameters<typeof stubFetch>[0] = []) {
  return stubFetch([
    { path: "/api/v1/me/partners/favourites", body: { items: [SAM] } },
    { path: "/api/v1/me/partners/recent", body: { items: [{ ...ALEX, last_played_at: "2030-09-09T16:00:00Z", games: 3 }] } },
    ...extra,
  ]);
}

function show(excludeUserIds: string[] = []) {
  const onPick = vi.fn<(p: PickedPlayer) => void>();
  renderPage(<PlayerPicker onPick={onPick} excludeUserIds={excludeUserIds} />, { reactStrictMode: true });
  return onPick;
}

const directoryCalls = (calls: StubCall[]) => calls.filter((c) => c.path.startsWith("/api/v1/members/directory"));

async function openTab(name: string) {
  await userEvent.setup().click(screen.getByRole("tab", { name }));
}

describe("PlayerPicker — the tabs", () => {
  it("fits five short tabs, Favourites first, and picks a favourite as a member", async () => {
    routes();
    const onPick = show();
    const tabs = within(screen.getByRole("tablist", { name: PICKER.tabsLabel })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([PICKER.favourites, PICKER.recent, PICKER.members, PICKER.link, PICKER.guest]);
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    expect(onPick).toHaveBeenCalledWith({ kind: "member", userId: "sam", name: SAM.name, photoUrl: null });
  });

  it("shows a member already on the booking as added, and will not pick them twice", async () => {
    routes();
    const onPick = show(["sam"]);
    const row = await screen.findByRole("button", { name: `${SAM.name}, ${PICKER.added}` });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText(PICKER.added)).toBeTruthy();
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows skeletons while reading, then says so honestly when there are no favourites", async () => {
    stubFetch([
      { path: "/api/v1/me/partners/favourites", body: { items: [] } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
    ]);
    show();
    expect(document.querySelector('[data-state-block="loading"]')).not.toBeNull();
    expect(await screen.findByText(PICKER.favouritesEmpty)).toBeTruthy();
    expect(screen.getByText(PICKER.favouritesEmptyHint)).toBeTruthy();
  });

  it("says a failed read in words, with a retry — never an empty list", async () => {
    let down = true;
    stubFetch([
      { path: "/api/v1/me/partners/favourites", respond: () => (down ? refuse(409, { error: "conflict_retry" }) : { items: [SAM] }) },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
    ]);
    show();
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByText(PICKER.favouritesEmpty)).toBeNull();
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: PICKER.add(SAM.name) })).toBeTruthy();
  });

  it("Recent says how often and when you last played", async () => {
    routes();
    show();
    await openTab(PICKER.recent);
    const row = await screen.findByRole("button", { name: PICKER.add(ALEX.name) });
    expect(row).toHaveTextContent(`${PICKER.played(3)} · ${PICKER.lastPlayed("Mon 9 Sep")}`);
  });

  it("an open seat and a guest are picks of their own; a guest needs a name", async () => {
    routes();
    const onPick = show();
    await openTab(PICKER.link);
    expect(screen.getByText(PICKER.linkBody)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PICKER.linkAdd }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: "link" });

    await openTab(PICKER.guest);
    expect(screen.getByText(PICKER.guestHint)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PICKER.guestAdd }));
    expect(screen.getByText(PLAYERS_REFUSAL.guest_name_invalid)).toBeTruthy();
    expect(onPick).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(PICKER.guestLabel), { target: { value: "  Jo  " } });
    fireEvent.click(screen.getByRole("button", { name: PICKER.guestAdd }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: "guest", name: "Jo" });
  });
});

describe("PlayerPicker — the club directory (D13)", () => {
  it("asks nothing below two letters, and only once the typing has settled for 300 ms", async () => {
    const stub = routes([{ path: "/api/v1/members/directory", body: { items: [JO] } }]);
    show();
    await openTab(PICKER.members);
    const box = screen.getByLabelText(PICKER.searchLabel);
    fireEvent.change(box, { target: { value: "j" } });
    expect(screen.getByText(PICKER.searchHint)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(directoryCalls(stub.calls)).toHaveLength(0);

    fireEvent.change(box, { target: { value: "jo" } });
    fireEvent.change(box, { target: { value: "jo " } });
    fireEvent.change(box, { target: { value: "jo v" } });
    // Mid-typing: nothing yet.
    expect(directoryCalls(stub.calls)).toHaveLength(0);
    expect(await screen.findByRole("button", { name: PICKER.add(JO.name) })).toBeTruthy();
    // One settled term was asked (StrictMode may ask it twice; never "jo" or "jo ").
    expect(new Set(directoryCalls(stub.calls).map((c) => c.path))).toEqual(new Set(["/api/v1/members/directory?q=jo%20v"]));
  });

  it("explains an empty answer — only members who chose to be findable appear", async () => {
    routes([{ path: "/api/v1/members/directory", body: { items: [] } }]);
    show();
    await openTab(PICKER.members);
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), { target: { value: "zz" } });
    expect(await screen.findByText(PICKER.searchEmpty)).toBeTruthy();
    expect(screen.getByText(PICKER.searchEmptyHint)).toBeTruthy();
  });

  it("says the rate limit as a sentence, with its wait", async () => {
    const body = { error: "directory_rate_limited", retry_after_seconds: 12 };
    routes([{ path: "/api/v1/members/directory", status: 429, body }]);
    show();
    await openTab(PICKER.members);
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), { target: { value: "sam" } });
    const sentence = playersRefusal(new ApiError(429, body));
    expect(sentence).toMatch(/12 seconds/);
    expect(await screen.findByText(sentence)).toBeTruthy();
  });
});

describe("PlayerPicker — the star", () => {
  it("turns at once, and puts a recent partner in Favourites", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    routes([{ method: "PUT", path: "/api/v1/me/partners/favourites/alex", body: { user_id: "alex", favourite: true } }]);
    // Hold the PUT so the optimistic state is what is on screen.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") await gate;
      return real(input, init);
    }));
    show();
    await openTab(PICKER.recent);
    const star = await screen.findByRole("button", { name: PICKER.star(ALEX.name) });
    expect(star).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(star);
    expect(await screen.findByRole("button", { name: PICKER.unstar(ALEX.name) })).toHaveAttribute("aria-pressed", "true");
    await act(async () => { release(); });
    await openTab(PICKER.favourites);
    expect(await screen.findByRole("button", { name: PICKER.add(ALEX.name) })).toBeTruthy();
  });

  it("turns back when the server says no", async () => {
    const stub = routes([{ method: "DELETE", path: "/api/v1/me/partners/favourites/sam", respond: () => refuse(503, { error: "down" }) }]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: PICKER.unstar(SAM.name) }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: PICKER.unstar(SAM.name) })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: PICKER.add(SAM.name) })).toBeTruthy();
  });
});

describe("PlayerPickerDialog", () => {
  it("is the same picker in a dialog with its title and the close ×", async () => {
    routes();
    const onPick = vi.fn();
    renderPage(<PlayerPickerDialog open onOpenChange={() => undefined} title="Invite a player" onPick={onPick} excludeUserIds={[]} />);
    const dialog = screen.getByRole("dialog", { name: "Invite a player" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole("button", { name: PICKER.add(SAM.name) }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: "member", userId: "sam" }));
  });
});
