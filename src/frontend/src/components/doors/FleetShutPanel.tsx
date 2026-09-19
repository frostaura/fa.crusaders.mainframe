import { useState } from "react";
import { Card } from "../Card";
import { Alert } from "../Alert";
import { ConfirmButton } from "../ConfirmButton";
import { FleetResultPanel, type FleetResultState } from "./FleetResultPanel";
import { doorFleetReopenConfirm, doorFleetShutConfirm, doorExitIsMechanical } from "../../lib/gateCopy";
import { describeDeviceError } from "../../lib/deviceErrors";
import { doorEndpoints, type AdminDoorDevice } from "../../lib/api";

/** What the count line says about a club whose doors are not all in one state. */
function tally(total: number, open: number): string {
  const doors = `${total} ${total === 1 ? "door" : "doors"}`;
  if (open === total) return `${doors} · ${open} open`;
  if (open === 0) return `${doors} · all shut`;
  return `${doors} · ${open} open, ${total - open} shut`;
}

/**
 * The failure sentence, and it is only true because the API does this in ONE unit of work.
 *
 * If that ever becomes N requests, this sentence becomes a guess and has to change with it —
 * which is why the reason is written here rather than left as a comfortable phrase.
 */
const FLEET_FAILED = "Nothing was shut. The club's server refused the request and it is one"
  + " all-or-nothing change, so every door is exactly as it was.";

/**
 * Shut every door, or reopen the ones a shut-all shut.
 *
 * <p>
 * <b>Never rendered against an unknown count.</b> While the doors are loading the button is
 * disabled and says so, and a club with no gates gets no panel at all — zero doors is not a
 * state this control has an opinion about.
 * </p>
 *
 * <p>
 * <b>The partial state renders BOTH controls.</b> Two of four shut is the state an admin
 * arrives in after an incident, and a single button that said "Shut all doors" there would
 * name a number that is wrong: the label counts what is still open, and a Reopen control
 * stands beside it so the way back is on the same screen as the way in.
 * </p>
 */
export function FleetShutPanel({ doors, loading, failed, reload, onRetry }: {
  doors: AdminDoorDevice[];
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
  onRetry: () => void;
}) {
  const [result, setResult] = useState<FleetResultState | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!loading && !failed && doors.length === 0) return null;

  const open = doors.filter((d) => d.enabled).length;

  const run = async (action: "shut" | "reopen") => {
    setError(null);
    try {
      const answer = action === "shut"
        ? await doorEndpoints.doorsShutAll()
        : await doorEndpoints.doorsReopenAll();
      setResult({ action, doors: answer.doors, at: Date.now() });
      await reload();
    } catch (e) {
      setResult(null);
      setError(describeDeviceError(e, FLEET_FAILED));
    }
  };

  return (
    <section aria-labelledby="fleet-shut-heading">
      <Card className="space-y-3">
        <h2 id="fleet-shut-heading" className="text-base font-semibold">All doors</h2>
        {failed ? (
          <>
            <Alert tone="danger">Couldn't load the club's doors, so nothing can be shut from here.</Alert>
            <button type="button" onClick={onRetry} className="h-11 rounded-lg border border-control px-5 text-sm font-medium">
              Try again
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-text-muted">{loading ? "Loading the club's doors…" : tally(doors.length, open)}</p>
            <p className="text-sm text-text-secondary">
              Shutting every door takes effect at the club's server at once. Each door finds out the next
              time it reaches the server; a door that has lost the network never finds out, and keeps
              admitting booked members from the list it last downloaded for up to six hours.{" "}
              {doorExitIsMechanical()}
            </p>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="space-y-2">
              {open > 0 && (
                <ConfirmButton
                  idleLabel={open === doors.length ? "Shut all doors" : `Shut the ${open} ${open === 1 ? "door" : "doors"} still open`}
                  confirmLabel={doorFleetShutConfirm(open)}
                  ariaLabel={`Shut every door the club has open — ${open} of ${doors.length}`}
                  onConfirm={() => run("shut")}
                  tone="danger"
                  disabled={loading}
                  className="h-11 w-full"
                />
              )}
              {doors.length > open && (
                <ConfirmButton
                  idleLabel={open === 0 ? "Reopen all doors" : `Reopen all ${doors.length}`}
                  confirmLabel={doorFleetReopenConfirm(doors.length)}
                  ariaLabel={`Reopen every door the club shut together — ${doors.length}`}
                  onConfirm={() => run("reopen")}
                  disabled={loading}
                  className="h-11 w-full"
                />
              )}
            </div>
          </>
        )}
      </Card>
      {result && <FleetResultPanel state={result} />}
    </section>
  );
}
