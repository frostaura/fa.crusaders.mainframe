import { useState } from "react";
import { SegmentedTabs, SegmentedTabPanel } from "@/components/SegmentedTabs";

/**
 * The pre-facelift `SegmentedTabs`, kept verbatim from the old gallery because
 * `e2e/segmented-tabs.spec.ts` measures it here (thumb geometry, the 44px floor at a 32px root,
 * the vertical flip) by these three `data-testid`s. Retire this section in the same commit that
 * retires `SegmentedTabs` and that spec (plan: P7 removes the My Code tabs).
 *
 * Rendered once, in the page theme — the spec addresses each group by test id, and a second copy
 * would make every locator ambiguous.
 */
type Code = "booking" | "member";
type Long = "one" | "two" | "three";

const LONG_SEGMENTS: { value: Long; label: string }[] = [
  { value: "one", label: "Top-ups over time" },
  { value: "two", label: "Daily money flow" },
  { value: "three", label: "Bookings and no-shows" },
];

function TwoSegments() {
  const [code, setCode] = useState<Code>("booking");
  return (
    <div data-testid="tabs-two">
      <SegmentedTabs
        segments={[
          { value: "booking", label: "Booking code" },
          { value: "member", label: "Member code" },
        ]}
        value={code}
        onChange={setCode}
        label="Which code to show"
        panelId={(v) => `dev-panel-${v}`}
      />
      <SegmentedTabPanel id={`dev-panel-${code}`} className="mt-3 text-sm text-text-secondary">
        {`The ${code} code would be here.`}
      </SegmentedTabPanel>
    </div>
  );
}

function DisabledSegment() {
  return (
    <div data-testid="tabs-disabled">
      <SegmentedTabs
        segments={[
          {
            value: "booking",
            label: "Booking code",
            disabled: true,
            disabledReason: "You have no booking starting in the next 2 hours, so there is no booking code to show.",
          },
          { value: "member", label: "Member code" },
        ]}
        value="member"
        onChange={() => undefined}
        label="Which code to show, one unavailable"
        panelId={(v) => `dev-off-${v}`}
      />
      <SegmentedTabPanel id="dev-off-member" className="mt-3 text-sm text-text-secondary">
        The member code would be here.
      </SegmentedTabPanel>
    </div>
  );
}

function LongLabels() {
  const [long, setLong] = useState<Long>("one");
  return (
    <div data-testid="tabs-long">
      <SegmentedTabs segments={LONG_SEGMENTS} value={long} onChange={setLong} label="Which chart to show" panelId={(v) => `dev-chart-${v}`} />
      <SegmentedTabPanel id={`dev-chart-${long}`} className="mt-3 text-sm text-text-secondary">
        {`Chart ${long}.`}
      </SegmentedTabPanel>
    </div>
  );
}

export function LegacySection() {
  return (
    <div className="flex flex-col gap-6 rounded-xl border border-border bg-bg-surface p-4">
      <TwoSegments />
      <DisabledSegment />
      <LongLabels />
    </div>
  );
}
