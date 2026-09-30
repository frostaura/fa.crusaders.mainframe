import { useState } from "react";
import { type AddPlayersAnswer, type BookingDetail, type DetailPlayer } from "@/lib/playersApi";
import { focusAfterAction } from "@/lib/focusAfterAction";
import { DETAIL_ACTIONS, DETAIL_ADMIN, PLAYERS_LOST } from "@/lib/playersCopy";
import type { AdminAct } from "../detail/detailModel";
import type { ShareTarget } from "../detail/ShareLinkDialog";
import type { Notice } from "../detail/useOrganiserHands";

/**
 * The admin's god mode on the booking page: which seat act is open, the add, and the link of an
 * open seat the add just made (its token is shown this once, so it is offered at once).
 */
export function useAdminHands(detail: BookingDetail, reload: () => void, say: (notice: Notice) => void) {
  const [acting, setActing] = useState<{ act: AdminAct; player: DetailPlayer } | null>(null);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  return {
    detail,
    reload,
    say,
    acting,
    act: (act: AdminAct, player: DetailPlayer) => setActing({ act, player }),
    closeAct: () => setActing(null),
    actDone: (notice: Notice) => {
      setActing(null); say(notice); reload();
      // R2 F2-12 — the seat's menu may be gone with the seat: the Players heading takes focus.
      focusAfterAction(() => document.querySelector<HTMLElement>("[data-players-section] h2"));
    },
    adding,
    openAdd: () => setAdding(true),
    closeAdd: () => setAdding(false),
    added: (answer: AddPlayersAnswer, kind: string, proven = false) => {
      setAdding(false);
      say({ tone: "success", text: proven ? PLAYERS_LOST(DETAIL_ADMIN.added) : DETAIL_ADMIN.added });
      // A link seat found by a read-back (R3) has no token to show: the dialog makes a new link.
      const seat = kind === "link" ? answer.participants.find((p) => p.invite_path) ?? (proven ? answer.participants[0] : undefined) : undefined;
      if (seat) setSharing({ name: DETAIL_ACTIONS.openSeatName, participantId: seat.participant_id, path: seat.invite_path ?? null });
      reload();
    },
    sharing,
    closeShare: () => setSharing(null),
  };
}

export type AdminHands = ReturnType<typeof useAdminHands>;

