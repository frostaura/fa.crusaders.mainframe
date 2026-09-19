import { useState } from "react";
import { Button } from "../Button";
import type { MemberDoor, MemberDoorContact } from "../../lib/api";
import type { LastKnown } from "../../lib/lastKnown";
import { minutesSince } from "../../lib/lastKnown";
import { formatClock } from "../../lib/countdown";
import { DIAGNOSIS_TRIGGER } from "../../lib/memberDoorCopy";
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
export function DoorSection(props: {
  door: MemberDoor | null;
  cached: LastKnown;
  doorRead: MemberDoorRead;
  contact: MemberDoorContact;
  /** Seconds left on the code the member is holding, or 0 when there is none. */
  codeSecondsLeft: number;
  /** Fetches a fresh code and resolves when it has settled. */
  onRefreshCode: () => Promise<void>;
}) {
  const { door, cached, doorRead, contact, codeSecondsLeft, onRefreshCode } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const opensAt = door?.next_booking?.door_opens_at ?? null;
  const opensIn = useCountdownSeconds(opensAt);
  const standing = (door ?? cached.door?.value) ?? null;

  /** Both reads forced, and the checklist rendered only once they settle — never a stale tick. */
  const run = async () => {
    setOpen(true);
    setBusy(true);
    try {
      await Promise.allSettled([doorRead.refresh(), onRefreshCode()]);
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
        failed={doorRead.failed}
      />

      {open ? (
        <SelfDiagnosis
          busy={busy}
          onHide={() => setOpen(false)}
          input={{
            // An UNKNOWN membership is not a failed one. Defaulting to "active" here is
            // what lets the connection row — evaluated next, and the true finding — win
            // instead of the page blaming a membership it could not read.
            membership: standing?.membership ?? "active",
            policy: standing?.policy ?? "active_member",
            hasBooking: !!door?.next_booking,
            bookingStartsClock: door?.next_booking ? formatClock(door.next_booking.starts_at) : null,
            doorWindowOpen: opensAt === null ? null : (opensIn ?? 0) <= 0,
            opensAtClock: opensAt ? formatClock(opensAt) : null,
            opensInWords: opensIn !== null && opensIn > 0 ? spokenCountdown(opensIn) : null,
            codeSecondsLeft,
            connectionOk: !doorRead.failed,
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
