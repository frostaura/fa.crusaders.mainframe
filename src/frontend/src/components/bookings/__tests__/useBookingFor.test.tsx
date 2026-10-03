import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { signIn, signOut, stubFetch } from "@/test/harness";
import { useBookingFor } from "../useBookingFor";

/**
 * R6 J6-2 — booking FOR a member, the bar's "can spend" figure was read once per member and day,
 * so after the desk booked for them it still showed what they had before, until a reload. The
 * page's change counter (`refreshKey`) re-reads it — and the last figure stays on screen while it
 * does, never a skeleton flash.
 */
const MEMBER = "33333333-3333-3333-3333-333333333333";
const DAY = "2026-10-04";

function detail(balance: number) {
  return [
    { path: `/api/v1/admin/members/${MEMBER}/booking-rules`, body: { groups: [], day: DAY, allowed_windows: null, empty_window_groups: null } },
    { path: `/api/v1/admin/members/${MEMBER}`, body: { full_name: "Ana Dlamini", balance_minutes: balance, held_minutes: 0, owed_back_minutes: 0 } },
  ];
}

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("useBookingFor (R6 J6-2)", () => {
  it("re-reads the member when the page says something changed, keeping the last figure meanwhile", async () => {
    signIn({ isAdmin: true });
    stubFetch(detail(100));
    const { result, rerender } = renderHook(({ key }) => useBookingFor(MEMBER, DAY, key), { initialProps: { key: 0 } });
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", member: { spendable: 100 } }));

    // The desk booked 30 minutes for them: the club now says 70.
    stubFetch(detail(70));
    rerender({ key: 1 });
    expect(result.current.state, "the last figure, not a skeleton").toMatchObject({ status: "ready", member: { spendable: 100 } });
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", member: { spendable: 70 } }));
  });

  it("another member or day is a new read: no figure of the last one is shown", async () => {
    signIn({ isAdmin: true });
    stubFetch(detail(100));
    const { result, rerender } = renderHook(({ day }) => useBookingFor(MEMBER, day, 0), { initialProps: { day: DAY } });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    rerender({ day: "2026-10-05" });
    expect(result.current.state.status).toBe("loading");
  });
});
