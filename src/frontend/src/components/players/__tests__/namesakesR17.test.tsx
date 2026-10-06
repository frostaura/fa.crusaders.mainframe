import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage, signOut, stubFetch } from "@/test/harness";
import { PICKER } from "@/lib/playersCopy";
import { PlayerPicker } from "../PlayerPicker";
import { namesakeDetails } from "../picker/namesake";

/**
 * R17 L17-2 (J16-3 partly) — before launch everyone joined the same month, so two "Pia van
 * Partner"s who never played with you both read "Member since Oct 2026". BE17c's contract: the
 * picker escalates a group of same-named rows whose lines are still equal — the full club date
 * from `member_since`, then the member's short club ref — so two visible rows never share a line.
 * A unique name keeps the short line. Never an email, phone or membership number.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); window.sessionStorage.clear(); });

const pia = (id: string, since: string, ref: string, games = 0) => ({
  user_id: id, name: "Pia van Partner", photo_url: null, played_with_you: games,
  last_played_with_you_at: games > 0 ? "2026-09-23T16:00:00Z" : null, member_since: since, member_ref: ref,
});
const SOLO = { user_id: "solo", name: "Sam Petersen", photo_url: null, played_with_you: 0, last_played_with_you_at: null, member_since: "2026-10-01", member_ref: "A1B2" };

const plain = (s: string | null | undefined) => (s ?? "").replace(/\u00a0/g, " ");
const said = (rows: readonly { user_id: string }[], map: ReadonlyMap<string, string | null>) => rows.map((r) => plain(map.get(r.user_id)));

describe("namesakes told apart, step by step (R17 L17-2)", () => {
  it("same month, different days: the full club date", () => {
    const rows = [pia("a", "2026-10-01", "K7Q2"), pia("b", "2026-10-06", "M3X9"), SOLO];
    expect(said(rows, namesakeDetails(rows))).toEqual(["Member since 1 Oct 2026", "Member since 6 Oct 2026", "Member since Oct 2026"]);
  });

  it("same day: the club ref is added — and a unique name keeps its short line", () => {
    const rows = [pia("a", "2026-10-06", "K7Q2"), pia("b", "2026-10-06", "M3X9"), SOLO];
    expect(said(rows, namesakeDetails(rows))).toEqual([
      "Member since 6 Oct 2026 · ref K7Q2", "Member since 6 Oct 2026 · ref M3X9", "Member since Oct 2026",
    ]);
  });

  it("three namesakes: the two still equal escalate, the third keeps its distinct line", () => {
    const rows = [pia("a", "2026-10-06", "K7Q2"), pia("b", "2026-10-06", "M3X9"), pia("c", "2026-09-30", "Z9Z9")];
    const out = said(rows, namesakeDetails(rows));
    expect(out[2]).toBe("Member since Sep 2026");
    expect(new Set(out).size).toBe(3);
  });

  it("played with you the same number of times on the same day: escalated past that line too", () => {
    const rows = [pia("a", "2026-10-02", "K7Q2", 2), pia("b", "2026-10-05", "M3X9", 2)];
    expect(said(rows, namesakeDetails(rows))).toEqual(["Member since 2 Oct 2026", "Member since 5 Oct 2026"]);
  });

  it("a club date is a date: never shifted by the reader's zone", () => {
    const rows = [pia("a", "2026-10-01", "K7Q2"), pia("b", "2026-10-31", "M3X9")];
    expect(said(rows, namesakeDetails(rows))).toEqual(["Member since 1 Oct 2026", "Member since 31 Oct 2026"]);
  });

  it("names differing only by case or spaces are namesakes", () => {
    const rows = [pia("a", "2026-10-06", "K7Q2"), { ...pia("b", "2026-10-06", "M3X9"), name: " pia van partner " }];
    expect(new Set(said(rows, namesakeDetails(rows))).size).toBe(2);
  });

  it("an older API without the ref still escalates to the full date, and adds nothing it does not have", () => {
    const rows = [{ ...pia("a", "2026-10-06", "K7Q2"), member_ref: undefined }, { ...pia("b", "2026-10-06", "M3X9"), member_ref: undefined }];
    expect(said(rows, namesakeDetails(rows))).toEqual(["Member since 6 Oct 2026", "Member since 6 Oct 2026"]);
  });
});

describe("the member's picker renders the escalated line (R17 L17-2)", () => {
  it("two never-played namesakes in the directory read differently, seen and heard", async () => {
    stubFetch([
      { path: "/api/v1/me/partners/favourites", body: { items: [] } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
      { path: "/api/v1/members/directory", body: { items: [pia("a", "2026-10-06", "K7Q2"), pia("b", "2026-10-06", "M3X9")] } },
    ]);
    renderPage(<PlayerPicker onPick={() => {}} excludeUserIds={[]} />);
    await userEvent.setup().click(screen.getByRole("tab", { name: PICKER.members }));
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), { target: { value: "pia" } });
    const rows = await screen.findAllByRole("button", { name: PICKER.add("Pia van Partner") }, { timeout: 3_000 });
    const heard = rows.map((r) => plain((r.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()));
    expect(heard).toEqual(["Member since 6 Oct 2026 · ref K7Q2", "Member since 6 Oct 2026 · ref M3X9"]);
    expect(document.body.textContent).not.toMatch(/@|#\d/);
  });

  it("two recent namesakes with the same games and day are told apart too", async () => {
    const recent = (id: string, since: string, ref: string) => ({ ...pia(id, since, ref, 3), last_played_at: "2026-09-23T16:00:00Z", games: 3 });
    stubFetch([
      { path: "/api/v1/me/partners/favourites", body: { items: [] } },
      { path: "/api/v1/me/partners/recent", body: { items: [recent("a", "2026-10-01", "K7Q2"), recent("b", "2026-10-02", "M3X9")] } },
    ]);
    renderPage(<PlayerPicker onPick={() => {}} excludeUserIds={[]} />);
    const rows = await screen.findAllByRole("button", { name: PICKER.add("Pia van Partner") }, { timeout: 3_000 });
    const heard = rows.map((r) => plain(document.getElementById(r.getAttribute("aria-describedby") ?? "")?.textContent));
    expect(new Set(heard).size).toBe(2);
  });
});
