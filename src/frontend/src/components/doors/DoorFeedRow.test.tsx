import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DoorFeedRow } from "./DoorFeedRow";
import type { DeviceActivityEntry } from "../../lib/api";

/**
 * R7 X7-7: axe reported aria-prohibited-attr five times on the doors log — every row's `<time>`
 * carried `aria-label="When: …"`, and `time` has no role that may be named. The long form is an
 * sr-only span inside it now, so the fact still arrives once and complete.
 */
describe("DoorFeedRow — the row's time", () => {
  const entry = {
    at: "2026-09-30T17:05:00Z", action: "gate.opened", reason: null, offline: false,
    received_at: null, user_id: "u1", user_name: "Bea Nkosi", device_id: "d1", device_code: "gate-598a9a",
  } as unknown as DeviceActivityEntry;

  it("is named by text, never by an aria-label on <time>", () => {
    const { container } = render(<ul><DoorFeedRow entry={entry} now={Date.parse("2026-09-30T17:10:00Z")} timezone="Africa/Johannesburg" /></ul>);
    const time = container.querySelector("time")!;
    expect(time).not.toHaveAttribute("aria-label");
    expect(time.querySelector(".sr-only")?.textContent).toMatch(/^When: /);
    expect(time).toHaveAttribute("dateTime", "2026-09-30T17:05:00Z");
  });
});
