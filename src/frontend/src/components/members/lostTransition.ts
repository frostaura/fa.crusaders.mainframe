import { ApiError } from "@/lib/api";
import { memberDetailEndpoints, type MembershipStatus } from "@/lib/memberDetailApi";

/**
 * What a membership transition actually did when its reply did not say (review round 2, F3-3).
 *
 * <p>
 * An approval committed and its reply was lost; the console said "Approval failed." about a
 * member who was already Active. The member is read again and the answer is one of three:
 * `done` (the status the transition aims at is the status they have), `not_done` (the read
 * worked and they are not there, or the server refused outright), or `unknown` (the reply was
 * lost AND the member could not be read) — never "failed" over a change that landed.
 * </p>
 */
export type TransitionTruth = "done" | "not_done" | "unknown";

export async function transitionTruth(
  userId: string, target: MembershipStatus, err: unknown,
): Promise<TransitionTruth> {
  let status: MembershipStatus | null | undefined;
  try {
    status = (await memberDetailEndpoints.detail(userId))?.status;
  } catch {
    status = undefined;
  }
  if (status === target) return "done";
  if (typeof status === "string") return "not_done";
  const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
  return refused ? "not_done" : "unknown";
}
