import { Card } from "../components/ui/card";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { cn } from "../lib/utils";
import { TextLink } from "../components/ui/text-link";
import { typography } from "../lib/typography";
import { ILLUSTRATIONS } from "../components/onboarding/Illustrations";
import { useDoorsFlag } from "../components/member-door/useMemberDoor";
import { GUIDE_INTRO, GUIDE_TITLE, guideSteps } from "../lib/onboardingCopy";

/**
 * The always-reachable half of item 16.
 *
 * <p>
 * <b>It has no "seen" state at all, and that is the design.</b> NN/g's two hard requirements
 * for onboarding help are that it be easy to dismiss and easy to RECALL; the card that gets
 * pushed after a booking is the first, and this is the second. A guide that remembers you
 * have read it is a guide you cannot read again, which for somebody who visits once a week is
 * the same as not having one.
 * </p>
 *
 * <p>
 * Reached from three places, which is NN/g's "dismissible overlays remain accessible through
 * a permanent menu option" met three times over: a tile on the home screen, a link under the
 * code on `/my-code`, and the profile page.
 * </p>
 *
 * <p>
 * <b>No carousel.</b> `components/Carousel.tsx` exists and is wrong here: a member reading
 * instructions has to be able to look back at step three without losing step four, and on a
 * phone a carousel hides four fifths of the guide behind a gesture nobody is told about. It
 * is an ordered list of sections, which is what a set of instructions is.
 * </p>
 *
 * <p>
 * <b>Signed out as well as in.</b> A member who cannot get their password to work, or an
 * applicant waiting for approval, is exactly the person wondering how any of this works. The
 * one read it makes — whether the club has doors — answers "unknown" for them, which keeps
 * the door step and promises nothing.
 * </p>
 */
/**
 * R6 L6-17 — the steps in one, two or three columns by the LIST's width (so 200 % text keeps
 * fewer), every card in a row one height, and the last step widened to close its row: seven steps
 * in threes left step 7 alone at 1024 beside two empty tracks.
 */
const STEPS_GRID = "grid grid-cols-1 gap-6 @[38rem]/steps:grid-cols-2 @[58rem]/steps:grid-cols-3";

/** The last step's span at two columns and at three: whatever its row has left. */
function lastStepSpan(count: number): string {
  const two = count % 2 === 1 ? "@[38rem]/steps:col-span-2" : "";
  const three = ["@[58rem]/steps:col-span-1", "@[58rem]/steps:col-span-3", "@[58rem]/steps:col-span-2"][count % 3];
  return cn(two, three);
}

export default function HowItWorksPage() {
  // doors: member — the same three-answer flag the home tile uses. "No" removes the door step
  // entirely, because a club with no gate must not meet the word; "unknown" keeps it, because
  // a member who HAS one and is not told is a member stuck outside a building.
  const doors = useDoorsFlag();

  /*
    `button_map` is not on any member-facing read, so the court-box step describes the two
    rows of buttons rather than quoting labels the page has not been given. The copy module
    takes the map the day one is served; until then a description is true at every club and a
    quoted guess is true at none.
  */
  const steps = guideSteps({ doors });

  return (
    // R4 form factor (SPEC P3): `content`, `wide` from xl, the steps as cards in rows (two at
    // lg, three on a wide page) rather than one 36rem column of them.
    <PageShell width="content" className="xl:max-w-wide">
      <PageHeader title={GUIDE_TITLE} description={GUIDE_INTRO} />
      <div className="@container/steps">
      <ol className={STEPS_GRID}>
        {steps.map((step, index) => {
          const Illustration = step.illustration ? ILLUSTRATIONS[step.illustration] : null;
          return (
            <li key={step.id} className={cn("flex", index === steps.length - 1 && lastStepSpan(steps.length))}>
              <Card className="@container/step w-full px-4 sm:px-6">
                <h2 className={`${typography({ variant: "h3" })} flex items-start gap-3`}>
                  {/* The step's number, as a badge — aria-hidden because the <ol> already says it. */}
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold tabular-nums text-accent-strong"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 self-center break-words">{step.title}</span>
                </h2>
                {/*
                  The drawing sits BESIDE the sentences in a card 28rem wide and above them in a
                  narrower one (the card's width, not the viewport's: three cards a row on a desktop
                  are narrow), and it never carries an instruction on its own — every one of the
                  paragraphs below says the same thing in words.
                */}
                <div className="flex flex-col gap-4 @[28rem]/step:flex-row @[28rem]/step:items-start">
                  <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm text-text-secondary @[28rem]/step:pl-11">
                    {step.body.map((line) => <p key={line}>{line}</p>)}
                  </div>
                  {Illustration && (
                    <div className="shrink-0 self-center text-text-secondary @[28rem]/step:self-start">
                      <Illustration />
                    </div>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
      </div>

      {/* Where a member goes next. Links, because both navigate. */}
      <nav aria-label="Next steps" className="flex flex-wrap gap-x-6">
        <TextLink to="/bookings" variant="standalone">Book a court</TextLink>
        <TextLink to="/my-code" variant="standalone">Your code</TextLink>
      </nav>
    </PageShell>
  );
}
