import { ApiError } from "@/lib/api";
import { clubClock } from "@/lib/clubClock";
import type { Invite, PartnerCap } from "@/lib/playersApi";
import {
  INVITE_REFUSAL, INVITES_COPY, acceptedUnpaidLine, firstName, playersRefusal, playersWhen,
} from "@/lib/playersCopy";

/**
 * The words an invite is read in, shared by the card, the sheet and the link page — so the list
 * and the sheet can never describe the same seat two ways.
 */

export type InviteTone = "info" | "warning" | "brand";

/** Where the seat stands, as one line: waiting · asked again · accepted with something to pay. */
export function inviteStatus(invite: Invite): { text: string; tone: InviteTone } {
  if (invite.needs_consent) return { text: INVITES_COPY.statusAskedAgain, tone: "warning" };
  if (invite.status === "accepted") return { text: acceptedUnpaidLine(invite.to_pay_credits), tone: "info" };
  return { text: INVITES_COPY.statusWaiting, tone: "brand" };
}

/** "Wed 30 Sep, 18:00–18:45" in the club's zone. */
export function inviteWhen(invite: Pick<Invite, "starts_at" | "ends_at">): string {
  return `${playersWhen(invite.starts_at)}–${clubClock(invite.ends_at)}`;
}

/** The organiser by first name — the grid's rule between members. */
export function organiserName(invite: Invite): string {
  return firstName(invite.organiser?.name);
}

/**
 * What the cap a yes would break says — through `playersRefusal`, so the sheet's warning and
 * the 409 the server would answer are the same sentence.
 */
export function inviteCapSentence(cap: PartnerCap): string {
  return playersRefusal(new ApiError(409, { error: "partner_cap_exceeded", ...cap }));
}

/** A refusal on the partner's side of an invite: second-person where it matters, else shared. */
export function inviteRefusal(error: unknown, action: string = INVITES_COPY.acceptAction): string {
  if (error instanceof ApiError && error.code && error.code in INVITE_REFUSAL) return INVITE_REFUSAL[error.code];
  return playersRefusal(error, { action });
}

/** The refusal's code, or null for anything that is not the API's answer. */
export function codeOf(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
