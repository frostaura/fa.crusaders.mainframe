import { useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { ConfirmButton } from "../components/ConfirmButton";
import { SegmentedTabs, SegmentedTabPanel } from "../components/SegmentedTabs";

/**
 * The primitives, on a real page, in a real engine — <b>development only</b>.
 *
 * <p>
 * <b>Why this exists.</b> `SegmentedTabs` and the action-feedback theme have properties that
 * only a layout engine can answer: the thumb is measured from the buttons rather than computed
 * from a fraction, the control flips to a vertical tablist when the labels stop fitting, and
 * every segment has to stay 44 px at a 32 px root font size. jsdom reports every offset as 0,
 * so none of that is testable in the unit runner — and the first consumer of the tabs is
 * `/my-code`, which belongs to another lane and does not exist yet. A primitive whose geometry
 * nothing measures is a primitive that is wrong on the phone nobody tested.
 * </p>
 *
 * <p>
 * <b>It is not in the production bundle.</b> `App.tsx` reaches it through a dynamic import
 * inside an `import.meta.env.DEV` branch, which Vite folds to `false` at build time, so the
 * route is dropped and the chunk is never referenced. The Playwright suite runs against
 * `npm run dev`, which is where it does exist.
 * </p>
 *
 * <p>
 * No auth guard, deliberately: it reads nothing, writes nothing, and asks the API for nothing,
 * so a guard would only make the spec sign in to look at a button.
 * </p>
 */

type Code = "booking" | "member";
type Long = "one" | "two" | "three";

export default function DevPrimitivesPage() {
  const [code, setCode] = useState<Code>("booking");
  const [long, setLong] = useState<Long>("one");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Primitives</h1>
      <p className="text-sm text-text-secondary">
        Development only. Nothing here talks to the club.
      </p>

      <Card>
        <h2 className="font-semibold mb-3">Segmented tabs — two segments</h2>
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
            The {code} code would be here.
          </SegmentedTabPanel>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-3">Segmented tabs — a disabled segment</h2>
        <div data-testid="tabs-disabled">
          <SegmentedTabs
            segments={[
              {
                value: "booking",
                label: "Booking code",
                disabled: true,
                disabledReason: "You have no booking starting in the next 2 hours, so there's no booking code to show.",
              },
              { value: "member", label: "Member code" },
            ]}
            value="member"
            onChange={() => {}}
            label="Which code to show, one unavailable"
            panelId={(v) => `dev-off-${v}`}
          />
          <SegmentedTabPanel id="dev-off-member" className="mt-3 text-sm text-text-secondary">
            The member code would be here.
          </SegmentedTabPanel>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-3">Segmented tabs — labels that stop fitting</h2>
        <div data-testid="tabs-long">
          <SegmentedTabs
            segments={[
              { value: "one", label: "Top-ups over time" },
              { value: "two", label: "Daily money flow" },
              { value: "three", label: "Bookings and no-shows" },
            ]}
            value={long}
            onChange={setLong}
            label="Which chart to show"
            panelId={(v) => `dev-chart-${v}`}
          />
          <SegmentedTabPanel id={`dev-chart-${long}`} className="mt-3 text-sm text-text-secondary">
            Chart {long}.
          </SegmentedTabPanel>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-3">Action feedback</h2>
        <div className="flex flex-wrap gap-2" data-testid="feedback-buttons">
          <Button
            intent="affirm"
            feedbackAnnouncement="Booked."
            onAction={() => new Promise<void>((resolve) => setTimeout(resolve, 400))}
          >
            Book for 50.00 cr
          </Button>
          <Button intent="decline" feedbackAnnouncement="Kept." onAction={() => {}}>
            Keep looking
          </Button>
          <Button
            intent="affirm"
            variant="primary"
            feedbackAnnouncement="Saved."
            failureAnnouncement="That didn't work."
            onAction={() => Promise.reject(new Error("refused"))}
          >
            Fails on purpose
          </Button>
          <Button>Neutral, exactly as before</Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <ConfirmButton
            tone="danger"
            idleLabel="Delete this board"
            cancelLabel="Keep it"
            subject="Court 2 board"
            confirmLabel="The board re-registers on its next heartbeat."
            onConfirm={() => new Promise<void>((resolve) => setTimeout(resolve, 300))}
          />
          <ConfirmButton
            idleLabel="Regenerate the key"
            confirmLabel="Every board has to be re-paired."
            subject="the club's device key"
            onConfirm={() => new Promise<void>((resolve) => setTimeout(resolve, 300))}
          />
        </div>
      </Card>
    </div>
  );
}
