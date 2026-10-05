import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaleNotice } from "@/components/shell/StaleNotice";
import { MemberCodePass } from "@/components/member-code/MemberCodePass";
import { MY_CODE } from "@/lib/myCodeCopy";
import { OfflineNothingKept } from "./OfflineNothingKept";
import { OFFLINE_COPY, asOfLabel } from "./offlineCopy";

/**
 * R15 X15-3 — "You're offline" is said only when the phone says it has no network
 * (`navigator.onLine === false`). A read that never reached the club from a phone that HAS a
 * network (Wi-Fi without internet, the club's system down) is "Can't reach the club — showing
 * what we had at …": the stale notice, the pass's badge and the nothing-kept notice alike.
 */

afterEach(() => { vi.restoreAllMocks(); });

const AT = new Date(2026, 9, 5, 14, 2).getTime();

function phoneOnline(onLine: boolean) {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(onLine);
}

describe("the stale notice (R15 X15-3)", () => {
  it("phone online, club unreachable: Can't reach the club — showing what we had at …", () => {
    phoneOnline(true);
    render(<StaleNotice stale readAt={AT} offline />);
    const note = screen.getByText(OFFLINE_COPY.unreachableTitle).closest("[data-stale-notice]")!;
    expect(note.textContent).toContain(OFFLINE_COPY.unreachableLine(AT));
    expect(note.textContent).toContain(`showing what we had at ${asOfLabel(AT)}`);
    expect(note.textContent).not.toContain(OFFLINE_COPY.staleTitle);
  });

  it("phone offline: You're offline", () => {
    phoneOnline(false);
    render(<StaleNotice stale readAt={AT} offline />);
    expect(screen.getByText(OFFLINE_COPY.staleTitle)).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_COPY.unreachableTitle)).toBeNull();
  });

  it("phone offline even when the read itself was a 5xx: You're offline", () => {
    phoneOnline(false);
    render(<StaleNotice stale readAt={AT} />);
    expect(screen.getByText(OFFLINE_COPY.staleTitle)).toBeInTheDocument();
  });

  it("the club answered with a failure, phone online: Couldn't refresh", () => {
    phoneOnline(true);
    render(<StaleNotice stale readAt={AT} />);
    expect(screen.getByText(OFFLINE_COPY.refreshFailedTitle)).toBeInTheDocument();
  });
});

describe("nothing kept (R15 X15-3)", () => {
  it("phone online: Can't reach the club, and no promise of 'once you're back online'", () => {
    phoneOnline(true);
    render(<OfflineNothingKept line={OFFLINE_COPY.nothingKept.wallet} />);
    const note = screen.getByText(OFFLINE_COPY.unreachableTitle).closest("[data-offline-nothing-kept]")!;
    expect(note.textContent).not.toContain("back online");
    expect(note.textContent).toContain(OFFLINE_COPY.unreachableTail);
  });

  it("phone offline: You're offline, the line as written", () => {
    phoneOnline(false);
    render(<OfflineNothingKept line={OFFLINE_COPY.nothingKept.activity} />);
    const note = screen.getByText(OFFLINE_COPY.staleTitle).closest("[data-offline-nothing-kept]")!;
    expect(note.textContent).toContain(OFFLINE_COPY.nothingKept.activity);
  });

  it("every nothing-kept line carries the tail the unreachable case rewrites", () => {
    const lines = [...Object.values(OFFLINE_COPY.nothingKept), OFFLINE_COPY.buyNeedsConnection];
    for (const line of lines) expect(line, line).toMatch(OFFLINE_COPY.backOnlineTail);
  });
});

describe("the pass's badge (R15 X15-3)", () => {
  const pass = (onLine: boolean) => {
    phoneOnline(onLine);
    render(<MemberCodePass token={null} remainingMs={0} offline memberName="Mia Jones" photoUrl={null} onOpenFullScreen={() => {}} />);
  };

  it("phone online, club unreachable: Can't reach the club — your code still works", () => {
    pass(true);
    expect(screen.getByText(OFFLINE_COPY.unreachableBadge)).toBeInTheDocument();
    expect(screen.queryByText(MY_CODE.offlineBadge)).toBeNull();
  });

  it("phone offline: Offline — your code still works", () => {
    pass(false);
    expect(screen.getByText(MY_CODE.offlineBadge)).toBeInTheDocument();
  });
});

describe("words said whatever navigator.onLine says (R15 X15-3 class sweep)", () => {
  it("never claim the phone is offline or out of signal", () => {
    for (const line of [OFFLINE_COPY.writeCause, OFFLINE_COPY.bookNeedsConnection, OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.wallet)]) {
      expect(line, line).not.toMatch(/offline|signal|back online/i);
    }
  });
});
