import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The top-up screen may not promise an email the API does not send.
 *
 * <p>
 * The failure copy on <code>TopUpStatus.tsx</code> told a member whose R500 status could not
 * be read that "we'll email you either way". Nothing emails on a failed, cancelled or
 * amount-mismatched top-up: <code>EmailDispatch.InBackground</code> occurs exactly once in
 * <code>TopUpEndpoints.cs</code>, inside <code>CompleteAsync</code>; the amount_mismatch,
 * Failed/Cancelled and provider_register_failed branches send nothing; <code>EmailTemplates</code>
 * carries a <code>TopUpConfirmation</code> and no failure template; and
 * <code>docs/specs/feature-spec.md</code> §11's required-email list names the confirmation and
 * no failure mail. A member reading that sentence would wait for a message that was never
 * going to arrive, about money they had already handed over.
 * </p>
 *
 * <p>
 * A unit test of the component could only have pinned whichever sentence happened to be there.
 * What makes a promise true or false is the <em>backend</em>, so this reads the backend — the
 * shipped files, in place, the same shape as <code>RepositoryPostureTests</code> reading
 * <code>AdminWebhooks.tsx</code> to hold the webhook catalogue equal to its emitters.
 * </p>
 *
 * <p>
 * It is deliberately bidirectional. Today there is no failure email, so the copy must not
 * promise one. If a lane adds a top-up failure template and dispatches it, the rule flips and
 * says so — because at that point the copy is out of date in the other direction and the
 * member should be told. Both directions are exercised below against synthetic sources, so the
 * branch that has not fired yet is tested rather than merely written; the two decision
 * functions are pure and take their sources as arguments for exactly that reason.
 * </p>
 */

const REPO = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO, ...parts), "utf8");

const API = ["src", "backend", "Crusaders.Mainframe.Api"];
const topUpEndpoints = read(...API, "Endpoints", "TopUpEndpoints.cs");
const emailTemplates = read(...API, "Email", "EmailTemplates.cs");
const pageSource = read("src", "frontend", "src", "pages", "TopUpStatus.tsx");

/**
 * Does the API mail a member when a top-up ends badly?
 *
 * <p>
 * A failure template has to exist AND be dispatched from the top-up endpoints. A template
 * nobody sends is not a promise the product keeps, and the confirmation being sent is not one
 * either — that is the mail this copy is already allowed to mention.
 * </p>
 */
export function sendsATopUpFailureEmail(templatesSource: string, endpointsSource: string): boolean {
  return [...templatesSource.matchAll(/public static EmailMessage\s+(\w+)/g)]
    .map((m) => m[1])
    // P13 §6 renamed the pair: `PurchaseConfirmation` / `PurchaseNotCompleted` (the old `TopUp*`
    // names are still read, so a tree mid-rename is judged too).
    .filter((n) => /^(TopUp|Purchase)/.test(n) && !/Confirmation$/.test(n))
    .some((n) => endpointsSource.includes(`EmailTemplates.${n}(`));
}

/** Member-facing text of the page, with JSX wrapping flattened and code comments removed. */
export function memberCopy(source: string): string {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\s+/g, " ");
}

/** Does the copy promise a mail whatever the outcome, rather than only on success? */
export function promisesMailWhateverHappens(copy: string): boolean {
  return /email you (either way|whatever|whichever|regardless)/i.test(copy);
}

describe("the top-up status screen's email promises", () => {
  it("finds the backend files it is judging against", () => {
    // A path that stops resolving would turn every assertion below into a silent pass, which
    // is the failure mode this whole file exists to prevent.
    expect(topUpEndpoints).toContain("CompleteAsync");
    expect(emailTemplates).toMatch(/public static EmailMessage (TopUp|Purchase)Confirmation/);
  });

  it("does not promise an email on a top-up that failed, cancelled or mismatched", () => {
    const promises = promisesMailWhateverHappens(memberCopy(pageSource));
    if (sendsATopUpFailureEmail(emailTemplates, topUpEndpoints)) {
      // Somebody added the failure mail. Good — but say so here on purpose, so the copy is
      // revisited rather than left narrower than the product.
      expect(
        promises,
        "The API now sends a top-up failure email. Widen the failure copy on TopUpStatus.tsx to " +
          "say so, and re-run this test.",
      ).toBe(true);
    } else {
      expect(
        promises,
        "TopUpStatus.tsx promises a member an email 'either way', but the only top-up mail the " +
          "API sends is TopUpConfirmation, from CompleteAsync. Either add a failure template and " +
          "dispatch it, or say only what the confirmation path actually does.",
      ).toBe(false);
    }
  });

  it("keeps the promise it does make — the confirmation is real and unconditional", () => {
    // The remaining sentences DO promise a mail when the payment clears, on both the
    // read-failed and the gave-up branches. That one is honest, and this is what makes it so.
    expect(memberCopy(pageSource)).toMatch(/we'll email you/i);
    // Dispatched from the completion path, not from a branch that might not run.
    const complete = topUpEndpoints.slice(topUpEndpoints.indexOf("CompleteAsync"));
    expect(complete).toMatch(/EmailTemplates\.(TopUp|Purchase)Confirmation\(/);
    expect(complete).toContain("EmailDispatch.InBackground(");
  });
});

/**
 * The two decisions above, against sources written for the purpose.
 *
 * <p>
 * The "a failure email now exists" branch cannot fire against today's tree, and a branch that
 * has never run is a branch nobody has checked. These give it inputs rather than waiting for
 * the money lane to supply them — and they do it without editing a backend file another lane
 * may have open.
 * </p>
 */
describe("the rule itself", () => {
  it("counts P13's purchase failure template when it is dispatched", () => {
    const templates = "public static EmailMessage PurchaseConfirmation(\npublic static EmailMessage PurchaseNotCompleted(";
    expect(sendsATopUpFailureEmail(templates, "EmailTemplates.PurchaseConfirmation(")).toBe(false);
    expect(sendsATopUpFailureEmail(templates, "EmailTemplates.PurchaseNotCompleted(")).toBe(true);
  });

  const CONFIRMATION_ONLY = "public static EmailMessage TopUpConfirmation(string to) => new(";
  const WITH_FAILURE =
    CONFIRMATION_ONLY + "\npublic static EmailMessage TopUpFailed(string to, string why) => new(";

  it("does not count the confirmation as a failure email", () => {
    expect(sendsATopUpFailureEmail(CONFIRMATION_ONLY, "EmailTemplates.TopUpConfirmation(to)")).toBe(false);
  });

  it("does not count a failure template nobody dispatches", () => {
    // Written and never wired is exactly how `NextRetryAt` sat dead in the webhook pipeline
    // for months. A template alone changes nothing a member receives.
    expect(sendsATopUpFailureEmail(WITH_FAILURE, "EmailTemplates.TopUpConfirmation(to)")).toBe(false);
  });

  it("counts a failure template that is dispatched", () => {
    expect(
      sendsATopUpFailureEmail(WITH_FAILURE, "EmailDispatch.InBackground(EmailTemplates.TopUpFailed(to, why));"),
    ).toBe(true);
  });

  it("reads 'either way' as an unconditional promise and the confirmation wording as not", () => {
    expect(promisesMailWhateverHappens("your credits are in your wallet, and we'll email you either way.")).toBe(true);
    expect(promisesMailWhateverHappens("we'll email you regardless")).toBe(true);
    expect(promisesMailWhateverHappens("your credits are in your wallet and we'll email you the confirmation.")).toBe(false);
  });

  it("ignores what the code comments say, and reads what a member sees", () => {
    // The comment above the paragraph quotes the retired sentence so the next reader knows why
    // it went. If this stripped nothing, that quotation alone would fail the page.
    const withCommentedQuote = '{/* it used to say "we\'ll email you either way" */}\n<p>we\'ll email you the confirmation.</p>';
    expect(promisesMailWhateverHappens(memberCopy(withCommentedQuote))).toBe(false);
  });
});
