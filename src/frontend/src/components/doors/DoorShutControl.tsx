import { Alert } from "../Alert";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { splitQuestion } from "../../lib/confirmCopy";
import { Button } from "../ui/button";
import {
  DOOR_REOPEN_LABEL, DOOR_SHUT_LABEL, doorReopenConfirm, doorShutConfirm, doorShutNotice,
  doorShutOfflineNotice, doorShutStandingNotice, type DoorSituation,
} from "../../lib/gateCopy";
import { doorShutHeard, doorShutHeardLine } from "../../lib/doorsCopy";
import { type AdminDoorDevice } from "../../lib/api";

/**
 * Shut one door, or reopen it. One control, one copy source, two labels.
 *
 * <p>
 * <b>It is never disabled because the door is silent.</b> Shutting a deaf door is still the
 * right action at the server — the API refuses every scan at it from the instant the switch
 * is thrown — and a control greyed out for a door nobody can reach would be the screen
 * refusing to do a thing it can do. What is honest about a silent door is not a disabled
 * button but the notice above it, which states both halves, and the result line after it,
 * which says the door has not confirmed.
 * </p>
 *
 * <p>
 * The `ariaLabel` names the door. "Shut this door" repeats down a list of doors, and
 * `ConfirmButton`'s own doc comment is about exactly this: a visible label is often not a
 * name.
 * </p>
 */
export function DoorShutControl({ door, onDone, shutAt, online, timezone }: {
  door: AdminDoorDevice;
  onDone: (enabled: boolean) => Promise<void>;
  /** A club-time clock face for `out_of_service_since`, or null where the payload has none. */
  shutAt: string | null;
  /**
   * Whether this door is reporting right now.
   *
   * C5: the reopen confirm promised "from the very next scan" to every door, including one
   * nobody can reach — a promise about a machine that is not listening. It is the door's own
   * liveness that decides which half of the pair is true of THIS door today.
   */
  online: boolean;
  /** The club's zone, for the confirmation clock face. R3-3: never the browser's. */
  timezone: string;
}) {
  /**
   * <b>R3-10 — confirming a shut or a reopen threw focus to `&lt;body&gt;`.</b>
   *
   * <p>
   * The two branches of this component are different elements, so the state change an admin
   * has just caused unmounts the very control they pressed. `ConfirmButton` restores focus to
   * its own trigger when it settles, and by the time the reload lands that trigger is gone —
   * so a keyboard user was returned to the top of the document, and a screen-reader user was
   * told nothing about the most consequential action on the surface.
   * </p>
   *
   * <p>
   * The new state's control is the right landing place rather than a heading: it is where the
   * person was, it now reads the opposite word, and reading it IS the confirmation that the
   * state flipped. Guarded on focus being genuinely adrift — a control may put back focus it
   * is about to destroy and may never take focus from somewhere else, which is the same rule
   * `ConfirmButton` states about itself.
   * </p>
   *
   * <p>
   * <b>R3 adoption: this is now `ConfirmButton`'s own `focusAfter`, not an effect here.</b>
   * The two did the same job under the same guard — `lib/focusAfterAction` acts only when
   * focus is on the body or on a node that has left the document — and the effect had one
   * defect the shared helper does not: it ran ONCE, in the tick the payload flipped, and
   * `door.enabled` flips when the page's re-read lands rather than when the action settles.
   * The helper keeps looking, backing off over about a second, precisely because the control
   * it is looking for is usually rendered by a later update than the one that removed the
   * old one. Two mechanisms for one behaviour is also how they drift.
   * </p>
   */
  /**
   * The control that will stand where this one stood — named by the state it belongs to.
   *
   * <p>
   * <b>Not "the first button in the wrapper".</b> That was the first shape of this and it is
   * a trap worth naming: `focusAfterAction` looks the instant the action settles, and at that
   * instant the page has not re-read itself yet, so the wrapper still holds the control that
   * is about to be replaced. The helper found it, focused it, and stood down — and the payload
   * then removed it, leaving focus on `&lt;body&gt;` with nothing left looking. A successor has
   * to be identified by what it WILL be, or the search resolves to the thing it is waiting for
   * to disappear.
   * </p>
   *
   * <p>
   * `wanted` is read at render time from the state this control is moving away FROM, so the
   * closure the confirm captures is asking for the other branch by name.
   * </p>
   */
  const wanted = door.enabled ? "shut" : "open";
  const successor = () => document.querySelector<HTMLElement>(
    `[data-door-control="${door.id}"][data-door-state="${wanted}"] button`,
  );
  // B3: ONE situation object, and every armed consequence below is generated from it. The
  // confirms used to describe the pair in the abstract, so a door in contact was told about
  // doors that are not — and an unnamed door, which holds no list at all, was told it goes
  // on admitting booked members from one.
  // R3-1: the third input, and on a shut door it outranks the other two. `undefined` where
  // the API does not carry it, which every generator below reads as "cannot tell" rather
  // than as either answer.
  const heard = doorShutHeard(door);
  const heardShut = heard.state === "unknown" ? undefined : heard.state === "confirmed";
  const situation: DoorSituation = { online, named: door.gate_key !== null, heardShut };
  if (!door.enabled) {
    return (
      // R3-10 / R3 adoption: the wrapper is NAMED, so the other branch can be found from
      // outside this component once React has rendered it. Both branches return a wrapper and
      // they are DIFFERENT elements to React — which is why focus landed on `<body>`: the
      // control an admin pressed is unmounted by the very state change it caused, and
      // `ConfirmButton`'s own restore has no trigger left to put it back on.
      <div data-door-control={door.id} data-door-state="shut" className="space-y-3">
        {/*
          C11: a shut door is a STANDING fact, and this sat in an assertive region on a page
          that re-reads itself every fifteen seconds. What is standing is polite; only a change
          somebody else caused earns an interruption. `live` is Alert's own prop — the role no
          longer depends on the order of a spread.
        */}
        {/*
          R3 adoption: `standing`, not `polite`. See the paragraph on C11 above — polite was
          right about the URGENCY and said nothing about the repetition. This branch is
          conditional on the door being shut, on a page that re-reads itself, so a poll that
          re-evaluates the condition mounts a fresh live region with the sentence already in
          it and a screen reader announces it again. Keyed on the DOOR rather than on the
          words, because a door shut, reopened and shut again produces the same sentence
          twice and the second shut is news.
        */}
        <Alert tone="danger" live="standing" announceKey={`door-shut:${door.id}`}>
          {doorShutStandingNotice(door.name, shutAt, door.shut_by_name ?? null)}
        </Alert>
        {/* R3-1: the confirmation clause, from `shut_heard_at` and never from an age. A door
            the server says HEARD the shut carries it in a neutral tone — there is nothing to
            warn about — and the warning below is reserved for the two states where the
            club genuinely does not know the door is refusing people. */}
        {heard.state === "confirmed" && (
          <p className="text-sm text-text-secondary">{doorShutHeardLine(door, timezone)}</p>
        )}
        {/* C2 / C5: shut AND not reporting are two facts and both are shown. A shut door
            nobody can reach has not heard the refusal — and what it does next depends on
            whether it was ever named, which is B3's whole finding.
            R3-1: and it renders on the DOOR's evidence, not on liveness alone. A door that
            has been told is silent for a reason that no longer matters. */}
        {heard.state !== "confirmed" && (!online || heard.state === "not_told") && (
          <p className="text-sm text-warning-strong">
            {doorShutOfflineNotice(door.name, situation.named, heardShut)}
          </p>
        )}
        <DoorConfirm
          label={DOOR_REOPEN_LABEL}
          doorName={door.name}
          sentence={doorReopenConfirm(situation)}
          cancelLabel="Leave it shut"
          tone="primary"
          // The Shut control that takes this one's place is where the person was standing.
          focusAfter={successor}
          onConfirm={() => onDone(true)}
        />
      </div>
    );
  }
  return (
    <div data-door-control={door.id} data-door-state="open" className="space-y-3">
      {/* A14: the power-loss sentence used to be printed here AND on the door card directly
          above, twice on one screen. The card is where it belongs — it has the room to say
          it is a property of the lock and not of this app.
          B5: this is the LONG explanation, as plain page text beside the control. The armed
          consequence is ≤25 words and is generated from this door's own situation. */}
      <p className="text-sm text-text-secondary">{doorShutNotice()}</p>
      <DoorConfirm
        label={DOOR_SHUT_LABEL}
        doorName={door.name}
        sentence={doorShutConfirm(situation)}
        cancelLabel="Keep it open"
        tone="danger"
        focusAfter={successor}
        onConfirm={() => onDone(false)}
      />
    </div>
  );
}

/**
 * Shut or reopen, confirmed in a dialog (P3 — it was the inline two-tap ConfirmButton). The
 * trigger's name carries the door ("Shut this door — Side door"), so a column of them is not a
 * column of identical controls; the dialog's title asks the question and its description is the
 * door's own consequence, generated from its situation (B3). The way out names what it keeps.
 */
function DoorConfirm(props: {
  label: string;
  doorName: string;
  sentence: string;
  cancelLabel: string;
  tone: "danger" | "primary";
  focusAfter: () => HTMLElement | null;
  onConfirm: () => Promise<void>;
}) {
  const { label, doorName, sentence, cancelLabel, tone } = props;
  const { question, consequence } = splitQuestion(sentence);
  return (
    <ConfirmDialog
      trigger={(
        <Button variant={tone === "danger" ? "danger-soft" : "secondary"} block className="h-auto min-h-touch whitespace-normal py-2">
          {label}{" "}<span className="sr-only">{`— ${doorName}`}</span>
        </Button>
      )}
      title={question ?? `${label}?`}
      description={consequence}
      confirmLabel={label}
      cancelLabel={cancelLabel}
      tone={tone}
      focusAfter={props.focusAfter}
      onConfirm={props.onConfirm}
    />
  );
}
