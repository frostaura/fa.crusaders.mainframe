import { useState } from "react";
import { Alert } from "../Alert";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { splitQuestion } from "../../lib/confirmCopy";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { FleetResultPanel, type FleetResultState } from "./FleetResultPanel";
import {
  doorFleetReopenConfirm, doorFleetReopenLabel, doorFleetShutConfirm, doorsStayShutNotice,
} from "../../lib/gateCopy";
import { describeDeviceError } from "../../lib/deviceErrors";
import { doorEndpoints } from "../../lib/api";
import { markOwnDoorsAction, type DoorsChrome } from "./useDoorsChrome";

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
 * The fleet write, out here rather than inside the component.
 *
 * <p>
 * It reads the clock — the result panel is a RECEIPT for one instant and must never drift
 * "confirmed 12s ago" into "confirmed 10m ago" — and a clock read in a function declared
 * inside a render body is what `react-hooks/purity` refuses, correctly. Lifting it out is
 * the honest fix; a `useCallback` around it would only have moved the early return.
 * </p>
 */
async function fleetAction(action: "shut" | "reopen", context: {
  /** The names the page already knows, for an API that does not send `left_shut` yet. */
  leftShutFallback: { id: string; name: string; gate_key: string | null }[];
  /** The club's zone, for the receipt's own clock faces (E2 / R3-3). */
  timezone: string | undefined;
  reload: () => Promise<void>;
  onResult: (result: FleetResultState | null) => void;
  onError: (message: string | null) => void;
}) {
  context.onError(null);
  try {
    // C11: the biggest change on this surface, and the one an admin is most plainly
    // looking at the result of. Polite for them; assertive for everybody else's tab.
    markOwnDoorsAction();
    const answer = action === "shut"
      ? await doorEndpoints.doorsShutAll()
      : await doorEndpoints.doorsReopenAll();
    context.onResult({
      action,
      doors: answer.doors,
      // The server's own list where it sends one (WIRE-W1 / C1's `left_shut`); the names
      // the page already knows otherwise, so the result is never silent about them.
      leftShut: answer.left_shut ?? context.leftShutFallback,
      at: Date.now(),
      // E2 / R3-3: the club's zone, so this receipt is dated in the club's day.
      timezone: context.timezone,
    });
    await context.reload();
  } catch (e) {
    context.onResult(null);
    context.onError(describeDeviceError(e, FLEET_FAILED));
  }
}

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
 * <b>The Reopen control exists ONLY while a shut-all is standing (C1).</b> It used to render
 * whenever any door was shut, labelled "Reopen all 3" from the club's total — but
 * `reopen-all` reopens only the doors a shut-all shut, so an admin who had shut one door on
 * its own and pressed it got `{"doors": []}`, the words "0 doors reopened", and no
 * explanation at all. Worse, after shut-one → shut-all → reopen-all the individually shut
 * door silently stayed shut with nothing on screen saying so. The semantics are right and
 * stay; what changes is that the control now exists only when it will do something, is
 * labelled with the number it will actually reopen, and NAMES the doors that will stay shut
 * before it is pressed as well as after.
 * </p>
 *
 * <p>
 * <b>Both controls are rendered in the partial state.</b> Two of four shut is the state an
 * admin arrives in after an incident, and a single button that said "Shut all doors" there
 * would name a number that is wrong: the label counts what is still open.
 * </p>
 */
export function FleetShutPanel({ chrome, loading, failed, reload, onRetry, timezone }: {
  /** The one shut-state source. See `useDoorsChrome` — this panel never derives its own. */
  chrome: DoorsChrome;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
  onRetry: () => void;
  /** The club's zone, for the result receipt's clock faces (E2 / R3-3). */
  timezone: string | undefined;
}) {
  const [result, setResult] = useState<FleetResultState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = chrome.doors.filter((d) => d.enabled).length;
  const shutTogether = chrome.doors.filter((d) => !d.enabled && d.shutByFleet);
  const shutAlone = chrome.doors.filter((d) => !d.enabled && !d.shutByFleet);
  const stayingShut = shutAlone.map((d) => d.name);
  // B3 at fleet scale: the doors this club actually has are countable, so the armed
  // consequence counts the ones that cannot hear it rather than describing doors in general
  // — and it distinguishes a named door, which keeps its cached list, from an unnamed one,
  // which holds nothing at all.
  const situationsOf = (doors: typeof chrome.doors) =>
    doors.filter((d) => !d.online).map((d) => ({ online: false, named: d.named }));
  const shutUnreachable = situationsOf(chrome.doors.filter((d) => d.enabled));
  const reopenUnreachable = situationsOf(shutTogether);
  // The names the result panel falls back to when the API does not send `left_shut` yet, so
  // a zero-change reopen still NAMES the doors it left alone rather than printing
  // "0 doors reopened" and stopping (C1).
  const leftShutFallback = shutAlone.map((d) => ({ id: d.id, name: d.name, gate_key: null }));

  const run = (action: "shut" | "reopen") => fleetAction(action, {
    leftShutFallback,
    timezone,
    reload,
    onResult: setResult,
    onError: setError,
  });

  if (!loading && !failed && chrome.total === 0) return null;

  return (
    <section aria-labelledby="fleet-shut-heading">
      <Card>
        <CardHeader>
          <CardTitle asChild><h2 id="fleet-shut-heading">All doors</h2></CardTitle>
          {!failed && (
            <CardDescription>
              {loading ? <Skeleton className="h-4 w-40" /> : tally(chrome.total, open)}
              {loading ? <span className="sr-only">Loading the club&apos;s doors…</span> : null}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
        {failed ? (
          <>
            <Alert tone="danger">Couldn't load the club's doors, so nothing can be shut from here.</Alert>
            <Button variant="outline" className="self-start" onClick={onRetry}>Try again</Button>
          </>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              Shutting every door takes effect at the club's server at once. Each door finds out the next
              time it reaches the server; a door that has lost the network never finds out, and keeps
              admitting booked members from the list it last downloaded for up to six hours. Getting
              out of the building is mechanical and none of this touches it.
            </p>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex flex-col gap-2">
              {open > 0 && (
                <FleetConfirm
                  label={open === chrome.total ? "Shut all doors" : `Shut the ${open} ${open === 1 ? "door" : "doors"} still open`}
                  context={`every door the club has open — ${open} of ${chrome.total}`}
                  cancelLabel="Keep them open"
                  // B6 / C-L2 / R3-23: the club's TOTAL as well as the count this will shut.
                  // "Shut all 2 doors?" over a club of three is false twice — it is not all
                  // of them, and it tells a reader the control reaches every door there is.
                  sentence={doorFleetShutConfirm(open, shutUnreachable, chrome.total)}
                  tone="danger"
                  disabled={loading}
                  onConfirm={() => run("shut")}
                />
              )}
              {shutTogether.length > 0 && (
                <>
                  <FleetConfirm
                    label={doorFleetReopenLabel(shutTogether.length)}
                    context={`every door the club shut together — ${shutTogether.length}`}
                    cancelLabel="Leave them shut"
                    sentence={doorFleetReopenConfirm(shutTogether.length, reopenUnreachable)}
                    tone="primary"
                    disabled={loading}
                    onConfirm={() => run("reopen")}
                  />
                  {/* Beside the control, at rest, not hidden until armed (A12). A consequence
                      an admin only meets after committing to the first tap is a consequence
                      the screen did not really state. */}
                  {doorsStayShutNotice(stayingShut) && (
                    <p className="text-sm text-text-secondary">{doorsStayShutNotice(stayingShut)}</p>
                  )}
                </>
              )}
              {shutTogether.length === 0 && shutAlone.length > 0 && (
                <p className="text-sm text-text-secondary">
                  {`${stayingShut.join(", ")} ${shutAlone.length === 1 ? "was" : "were"} shut`}
                  {shutAlone.length === 1 ? " on its own" : " one at a time"}
                  {`, so there is nothing here to reopen together. Reopen ${shutAlone.length === 1 ? "it" : "them"} from ${shutAlone.length === 1 ? "its" : "their"} own page.`}
                </p>
              )}
            </div>
          </>
        )}
        </CardContent>
      </Card>
      {result && <FleetResultPanel state={result} />}
    </section>
  );
}

/**
 * A fleet-wide shut or reopen, confirmed in a dialog (P3). The trigger's name says what it
 * reaches ("Shut all doors — every door the club has open — 2 of 3"); the dialog asks the
 * question and states the club's own consequence, counted from its doors (B3 at fleet scale).
 */
function FleetConfirm(props: {
  label: string;
  context: string;
  cancelLabel: string;
  sentence: string;
  tone: "danger" | "primary";
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const { label, context, sentence, tone } = props;
  const { question, consequence } = splitQuestion(sentence);
  return (
    <ConfirmDialog
      trigger={(
        <Button variant={tone === "danger" ? "danger" : "secondary"} block className="h-auto min-h-touch whitespace-normal py-2" disabled={props.disabled}>
          {label}{" "}<span className="sr-only">{`— ${context}`}</span>
        </Button>
      )}
      title={question ?? `${label}?`}
      description={consequence}
      confirmLabel={label}
      cancelLabel={props.cancelLabel}
      tone={tone}
      // The per-door receipt is what the admin is looking for next; the dialog must not hand
      // focus back to its trigger over the top of it.
      focusAfter={() => document.querySelector<HTMLElement>("[data-fleet-result-heading]")}
      onConfirm={props.onConfirm}
    />
  );
}
