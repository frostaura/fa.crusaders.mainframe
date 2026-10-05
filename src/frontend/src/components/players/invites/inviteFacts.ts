import { ApiError } from "@/lib/api";
import { UnsureOutcome } from "@/lib/bookingOutcome";
import { clubClock } from "@/lib/clubClock";
import type { Invite, PartnerCap } from "@/lib/playersApi";
import {
  INVITE_REFUSAL, INVITE_UNSURE, INVITES_COPY, PLAYERS_UNSURE, acceptedUnpaidLine, askedAgainLine, askedFirstLine, firstName, invitedLine,
  playersRefusal, playersWhen,
} from "@/lib/playersCopy";

/**
 * The words an invite is read in, shared by the card, the sheet and the link page — so the list
 * and the sheet can never describe the same seat two ways.
 */

export type InviteTone = "info" | "warning" | "brand";

/**
 * R14 J14-9 — the invite as the server may send it: `consented_minutes` (what the seat last said yes
 * to; BE asked to add it). 0 means the club accepted the seat without asking — nothing was agreed, so
 * nothing "went up". Absent (an older server): read as agreed, the words of before.
 */
type InviteWire = Invite & { consented_minutes?: number };

function neverAgreed(invite: InviteWire): boolean {
  return invite.needs_consent && invite.consented_minutes === 0;
}

/** Where the seat stands, as one line: waiting · asked (again) · accepted with something to pay. */
export function inviteStatus(invite: InviteWire): { text: string; tone: InviteTone } {
  if (neverAgreed(invite)) return { text: INVITES_COPY.statusAskedFirst, tone: "warning" };
  if (invite.needs_consent) return { text: INVITES_COPY.statusAskedAgain, tone: "warning" };
  if (invite.status === "accepted") return { text: acceptedUnpaidLine(invite.to_pay_minutes), tone: "info" };
  return { text: INVITES_COPY.statusWaiting, tone: "brand" };
}

/**
 * R4 M4-8 — the heading and the line under it. A seat that already said yes and is asked again
 * (its share went up) is not "invited": it reads "Your share went up" and names the new share.
 */
export function inviteHeading(invite: InviteWire, invitedTitle: string): { title: string; line: string } {
  const organiser = organiserName(invite);
  if (invite.status === "accepted" && neverAgreed(invite)) {
    return { title: INVITES_COPY.askedFirstTitle, line: askedFirstLine(invite.share_minutes) };
  }
  if (invite.status === "accepted" && invite.needs_consent) {
    return { title: INVITES_COPY.askedAgainTitle, line: askedAgainLine(organiser, invite.share_minutes) };
  }
  return { title: invitedTitle, line: invitedLine(organiser, invite.open_link) };
}

/**
 * R12 J12-3 — while "decline for good?" is being asked the heading is the question's own; the line
 * under it (who invited them) stays. Otherwise `inviteHeading`.
 */
export function answerHeading(invite: Invite, invitedTitle: string, askingDecline: boolean): { title: string; line: string } {
  const heading = inviteHeading(invite, invitedTitle);
  return askingDecline ? { ...heading, title: INVITES_COPY.declineSheetTitle } : heading;
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
  if (error instanceof UnsureOutcome) {
    // R3 I-3 — a decline's lost reply is its own sentence: "nothing was taken" is the accept's.
    const words = action === INVITES_COPY.declineAction ? PLAYERS_UNSURE.decline : INVITE_UNSURE;
    return error.checked ? words.checked : words.unchecked;
  }
  if (error instanceof ApiError && error.code && error.code in INVITE_REFUSAL) return INVITE_REFUSAL[error.code];
  return playersRefusal(error, { action });
}

/** The refusal's code, or null for anything that is not the API's answer. */
export function codeOf(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
