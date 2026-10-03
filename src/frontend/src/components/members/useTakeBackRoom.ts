import { useEffect, useState } from "react";
import { endpoints } from "@/lib/api";
import { memberDetailEndpoints } from "@/lib/memberDetailApi";
import type { TakeBackRoom } from "@/lib/deskMinutesCopy";

/**
 * R11 J11-2 — what of a member's balance a take-back cannot count as spendable (held for and owed
 * back to partners) and the club's shortest court (`slice_minutes`), read once a take-back is the
 * direction. Null until both reads land, and null for good when either fails or there is no
 * member to read: the Check step then says nothing about booking — an unknown is not "cannot book".
 */
export function useTakeBackRoom(userId: string | undefined, needed: boolean): TakeBackRoom | null {
  const [room, setRoom] = useState<{ userId: string; room: TakeBackRoom } | null>(null);
  const known = room && room.userId === userId ? room.room : null;
  useEffect(() => {
    if (!needed || !userId || known) return undefined;
    let live = true;
    Promise.all([memberDetailEndpoints.detail(userId), endpoints.adminSettingsGet()]).then(
      ([detail, settings]) => {
        if (!live) return;
        setRoom({
          userId,
          room: { held: detail.held_minutes ?? 0, owedBack: detail.owed_back_minutes ?? 0, slot: settings.slice_minutes },
        });
      },
      () => undefined,
    );
    return () => { live = false; };
  }, [needed, userId, known]);
  return known;
}
