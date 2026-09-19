import { ApiError, NetworkError, errorCode } from "./api";

/**
 * One place that turns a thrown error into a sentence a member can act on.
 *
 * <p>
 * Every screen used to end its error handling with a variant of "Check your connection and try
 * again." as the catch-all. That sentence is a diagnosis, and for most of the errors that
 * reached it the diagnosis was wrong. The register screen is the case that proved it: the club's
 * production database had no tenant row, so the API answered
 * <c>404 {"error":"tenant_not_found"}</c> to every attempt, and five people in a row were told
 * their internet was at fault. Nothing they could do would ever have worked, and the one person
 * who could fix it — whoever runs the stack — was never told.
 * </p>
 *
 * <p>
 * So the rule here is: only a {@link NetworkError} may be described as a connection problem,
 * because it is the only error that actually is one. Everything else either names what the club
 * decided, or admits that the club's system failed. "We don't know what went wrong" is an
 * acceptable thing to tell someone. "Your internet is broken" when it isn't is not.
 * </p>
 */

/**
 * Refusals that can arrive on ANY request, because they come from middleware rather than from
 * the endpoint the screen called. A screen that only maps its own endpoint's codes will show
 * its generic fallback for all of these — which is how a deployment fault reads as a mystery.
 */
const CROSS_CUTTING: Record<string, string> = {
  /**
   * The hostname resolved to a tenant slug that has no row. Always a deployment fault, never
   * anything the person reading it did. Say so plainly and point at who can fix it, rather than
   * offering a retry that cannot succeed.
   */
  tenant_not_found:
    "This club isn't set up on Mainframe yet, so nothing here can work. That's a setup problem on the club's side, not something you can fix — please let the club committee know.",
  tenant_unresolved:
    "We couldn't tell which club this request was for. If you reached this page from a link or a bookmark, try going to the club's own web address instead.",
  tenant_mismatch:
    "You're signed in to a different club than this address belongs to. Sign out and sign in again from the right address.",
  invalid_token: "Your session has expired. Sign in again.",
};

/** Sentences for HTTP statuses that mean the same thing wherever they appear. */
function describeStatus(status: number): string | null {
  if (status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (status === 502 || status === 503 || status === 504)
    return "The club's system is down or restarting. Give it a minute and try again — if it keeps happening, tell the club committee.";
  if (status >= 500)
    return "Something went wrong on the club's system. It isn't anything you did. Try again shortly, and tell the club committee if it keeps happening.";
  return null;
}

export type DescribeOptions = {
  /**
   * Sentences for the error codes this particular screen's endpoint can return. Checked before
   * the cross-cutting map, so a screen may override a shared sentence with a better-targeted one.
   */
  codes?: Record<string, string>;
  /**
   * What to say for a refusal this screen genuinely does not recognise. Must not blame the
   * member's connection — if you find yourself writing that here, you want {@link NetworkError}
   * handling instead, which is already done for you above.
   */
  fallback?: string;
};

/**
 * Turns anything thrown by the API client into a sentence.
 *
 * Resolution order, most specific first: the connection genuinely failing · this screen's own
 * codes · codes any request can produce · well-known statuses · the screen's fallback.
 */
export function describeFailure(err: unknown, opts: DescribeOptions = {}): string {
  if (err instanceof NetworkError) {
    return err.kind === "timeout"
      ? "The club's system took too long to answer. Check your connection and try again."
      : "We couldn't reach the club's system. Check your connection and try again.";
  }

  if (!(err instanceof ApiError)) {
    // Something threw that isn't ours at all — a bug in our own code, most likely. Do not
    // present that as either a network fault or a decision the club made.
    return opts.fallback ?? "Something went wrong. Try again, and tell the club committee if it keeps happening.";
  }

  const code = errorCode(err);
  if (code && opts.codes?.[code]) return opts.codes[code];
  if (code && CROSS_CUTTING[code]) return CROSS_CUTTING[code];

  const byStatus = describeStatus(err.status);
  if (byStatus) return byStatus;

  return opts.fallback ?? "That didn't work. Try again, and tell the club committee if it keeps happening.";
}

/**
 * True when the failure is a deployment or configuration fault rather than anything the person
 * reading it can act on. Screens use it to drop the retry affordance — offering "Try again" for
 * a missing tenant row is an invitation to press a button forever.
 */
export function isDeploymentFault(err: unknown): boolean {
  const code = errorCode(err);
  if (code === "tenant_not_found" || code === "tenant_unresolved") return true;
  return err instanceof ApiError && err.status >= 500;
}
