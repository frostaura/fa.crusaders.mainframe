import { useState } from "react";
import { Button } from "../Button";
import { endpoints, type MemberDoor } from "../../lib/api";
import type { LastKnown } from "../../lib/lastKnown";
import { minutesSince } from "../../lib/lastKnown";
import { clubClock } from "../../lib/clubClock";
import {
  type CodeOnScreen,
  DIAGNOSIS_TRIGGER,
  type ContactKnowledge,
  describeStanding,
  memberCodeOpensDoorNow,
  normaliseDoorsShut,
} from "../../lib/memberDoorCopy";
import { SelfDiagnosis } from "./SelfDiagnosis";
import { StandingLine } from "./StandingLine";
import type { MemberDoorRead } from "./useMemberDoor";
import { spokenCountdown, useCountdownSeconds } from "./useCountdownSeconds";

/**
 * The two door blocks that sit together below the code card: what opens the door for this
 * member right now, and the way in when it did not open.
 *
 * <p>
 * One component rather than two sites on the page, because both are gated on the same
 * question — does this club have a door at all — and because the self-diagnosis needs
 * every field the standing line already has. The club's contact is NOT here: it is the
 * page footer, and the walk-up switch sits between the two.
 * </p>
 */

/**
 * How recent a refusal has to be for the self-check to lead with it. E-H2 (2).
 *
 * <p>
 * The server's own `last_decision` window is two minutes, which is right for a card that
 * appears by itself and far too short for a control the member opens by hand: somebody who
 * has been refused, put the phone away, tried the other door and then pressed "The door
 * didn't open" is four or five minutes past it. Fifteen is long enough to catch the walk
 * round the building and short enough that yesterday's refusal never leads.
 * </p>
 */
const REFUSAL_WINDOW_MS = 15 * 60_000;

/** The club's own record of a recent refusal, or null. Newest row first, `last_decision` second. */
function recentRefusal(
  rows: { at: string; released: boolean; reason: string | null }[],
  decision: MemberDoor["last_decision"],
  timezone: string | undefined,
): { atClock: string; reason: string | null } | null {
  const candidates = [...rows, ...(decision ? [decision] : [])]
    .filter((row) => !row.released)
    .filter((row) => {
      const at = Date.parse(row.at);
      return !Number.isNaN(at) && Date.now() - at <= REFUSAL_WINDOW_MS && at <= Date.now();
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const newest = candidates[0];
  return newest ? { atClock: clubClock(newest.at, timezone), reason: newest.reason } : null;
}

export function DoorSection(props: {
  door: MemberDoor | null;
  cached: LastKnown;
  doorRead: MemberDoorRead;
  contact: ContactKnowledge;
  /** Seconds left on the code the member is holding, or 0 when there is none. */
  codeSecondsLeft: number;
  /** Which of the member's two codes is on screen. E-H2 (1). */
  code: CodeOnScreen | null;
  /** When the door facts on screen were read, or null while they are live. D6. */
  staleSince: string | null;
  /** Fetches a fresh code and resolves when it has settled. */
  onRefreshCode: () => Promise<void>;
  /** Switches the page to the member's own code. E-H2 (3). */
  onUseMemberCode: () => void;
  /** The decision card above is already offering "Book a court". See `StandingLine`. */
  actionOfferedAbove?: boolean;
}) {
  const { door, cached, doorRead, contact, codeSecondsLeft, code, staleSince } = props;
  const { onRefreshCode, onUseMemberCode } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The club's own record, read when the member asks rather than polled.
   *
   * <p>
   * E-H2 (2). `/me/door.last_decision` only carries a decision for two minutes, so the one
   * piece of evidence that is not a guess had usually expired by the time somebody pressed
   * the button. One extra read, on an explicit press, is what lets the conclusion lead with
   * what the club wrote down instead of with what this phone can see about itself.
   * </p>
   */
  const [refusal, setRefusal] = useState<{ atClock: string; reason: string | null } | null>(null);

  // Same precedence as the decision card's, and for the same reason: `too_early` is the
  // one state with an instant to wait for, and it is exactly the state in which
  // `next_booking` is null. The booking is the floor, not the source.
  const opensAt = door?.last_decision?.opens_at ?? door?.next_booking?.door_opens_at ?? null;
  const opensIn = useCountdownSeconds(opensAt);
  const standing = (door ?? cached.door?.value) ?? null;
  const zone = standing?.timezone;
  /** The window of the code ON SCREEN, which is a fact about the code and not about the member. */
  const codeWindow = useCodeWindow(code, zone);
  /** R3-8. A screen with nothing on it for a door to read promises nothing about one. */
  const hasLiveCode = codeSecondsLeft > 0;
  const line = standing ? describeStanding(standing, code, { hasLiveCode }) : null;

  /** Both reads forced, and the checklist rendered only once they settle — never a stale tick. */
  const run = async () => {
    setOpen(true);
    setBusy(true);
    try {
      const [history] = await Promise.allSettled([
        endpoints.meDoorHistory({ limit: 5 }),
        doorRead.refresh(),
        onRefreshCode(),
      ]);
      // `Array.isArray`, not `?? []`. A 200 whose body is the wrong shape — an older API,
      // a gateway's own JSON error page, a stub aimed at the wrong route — hands back an
      // object with no `items` at all, and spreading that threw out of a `.then` where
      // nothing was watching. The self-check then never rendered and the member, who had
      // pressed "The door didn't open", got a button that did nothing.
      const rows = history.status === "fulfilled" && Array.isArray(history.value?.items)
        ? history.value.items
        : [];
      const readZone = history.status === "fulfilled" ? history.value.timezone : zone;
      setRefusal(recentRefusal(rows, door?.last_decision ?? null, readZone ?? zone));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <StandingLine
        door={door}
        cached={cached.door}
        cachedMinutesAgo={cached.door ? minutesSince(cached.door.savedAt) : 0}
        loading={doorRead.loading}
        failure={doorRead.failure}
        code={code}
        staleSince={staleSince}
        hasLiveCode={hasLiveCode}
        onUseMemberCode={onUseMemberCode}
        actionOfferedAbove={props.actionOfferedAbove}
      />

      {open ? (
        <SelfDiagnosis
          busy={busy}
          onHide={() => setOpen(false)}
          onUseMemberCode={onUseMemberCode}
          input={{
            // Has the club's answer landed at all — live, or from the last-known store?
            // With neither, the four rows only the club can answer say so instead of
            // asserting off the defaults below, which is what produced "Your membership
            // — active ✓ Passed" above "This phone's line to the club — ✗ Failed".
            standingKnown: !!standing,
            // An UNKNOWN membership is not a failed one. Defaulting to "active" here is
            // what lets the connection row — evaluated next, and the true finding — win
            // instead of the page blaming a membership it could not read.
            membership: standing?.membership ?? "active",
            membership_detail: standing?.membership_detail ?? "active",
            policy: standing?.policy ?? "active_member",
            // `opens_at` exists only because `TooEarlyOpensAtAsync` FOUND a booking — one
            // whose window has not opened, which is precisely why `next_booking` is null
            // beside it. Keying this row on the booking alone told the one member who is
            // standing outside waiting for their court that they had nothing booked, and
            // then sent them to book another.
            hasBooking: !!door?.next_booking || !!door?.last_decision?.opens_at,
            bookingStartsClock: door?.next_booking ? clubClock(door.next_booking.starts_at, zone) : null,
            doorWindowOpen: opensAt === null ? null : (opensIn ?? 0) <= 0,
            opensAtClock: opensAt ? clubClock(opensAt, zone) : null,
            opensInWords: opensIn !== null && opensIn > 0 ? spokenCountdown(opensIn) : null,
            codeSecondsLeft,
            codeKind: code?.kind ?? null,
            codeWindow,
            lastRefusal: refusal,
            offerMemberCode: line?.offerMemberCode ?? false,
            // R3-5. The check had no idea the club had switched a door off, on a page whose
            // own standing line was saying so ten pixels above, and concluded that the
            // scanner might need a wipe. Read through `normaliseDoorsShut` so an absent
            // field stays "nobody told this screen" rather than becoming an answer.
            doorsShut: normaliseDoorsShut(standing?.doors_shut),
            doorsShutNames: standing?.doors_shut_names,
            // R3-6. Distinct from `offerMemberCode`, which is false for the member who is
            // ALREADY holding the code the club's rule admits — which was Lerato exactly.
            memberCodeOpensDoor: memberCodeOpensDoorNow(standing),
            // Not `!failed`. A 500 from the club's API is a read that failed and a phone
            // whose line works perfectly, and scoring that row ✗ sent a member to look for
            // signal they already had. See `MemberDoorRead.failure`.
            connection: doorRead.failure ?? "ok",
            contact,
          }}
        />
      ) : (
        // PERMANENT, not revealed by a refusal. An unknown or malformed token names
        // nobody, so the commonest refusal of all can never arrive by polling — and a
        // page that says nothing is the same dead end wearing better manners.
        <Button variant="outline" className="w-full" onClick={() => void run()}>
          {DIAGNOSIS_TRIGGER}
        </Button>
      )}
    </>
  );
}

/**
 * Where the booking code on screen stands against its own window, read off the clock.
 *
 * <p>
 * Never counted in ticks, for the reason every other clock on this surface is not: a phone
 * in a pocket fires none, and this is exactly the boundary it sleeps through. Null on a
 * member code, and null on a booking code the response sent no window for.
 * </p>
 */
function useCodeWindow(code: CodeOnScreen | null, zone: string | undefined) {
  const opens = code?.kind === "booking" ? code.doorOpensAt : null;
  const closes = code?.kind === "booking" ? code.doorClosesAt : null;
  const untilOpen = useCountdownSeconds(opens);
  // BOTH edges. A window judged on its opening alone reports a code from this morning as
  // open, which is the same class of error as judging it on its closing alone.
  const untilClose = useCountdownSeconds(closes);
  if (!opens || !closes) return null;
  return {
    open: (untilOpen ?? 0) <= 0 && (untilClose ?? 0) > 0,
    opensAtClock: clubClock(opens, zone),
    closesAtClock: clubClock(closes, zone),
  };
}
