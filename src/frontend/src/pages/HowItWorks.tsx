import { Link } from "react-router-dom";
import { Card } from "../components/Card";
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
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{GUIDE_TITLE}</h1>
        <p className="mt-1 text-text-secondary">{GUIDE_INTRO}</p>
      </header>

      <ol className="space-y-4">
        {steps.map((step, index) => {
          const Illustration = step.illustration ? ILLUSTRATIONS[step.illustration] : null;
          return (
            <li key={step.id}>
              <Card className="space-y-3">
                <h2 className="flex items-baseline gap-2 text-lg font-medium">
                  <span aria-hidden="true" className="text-text-muted">{index + 1}.</span>
                  {step.title}
                </h2>
                {/*
                  The drawing sits BESIDE the sentences from `sm` up and above them on a phone,
                  and it never carries an instruction on its own — every one of the paragraphs
                  below says the same thing in words.
                */}
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1 space-y-2 text-sm text-text-secondary">
                    {step.body.map((line) => <p key={line}>{line}</p>)}
                  </div>
                  {Illustration && (
                    <div className="shrink-0 self-center sm:self-start">
                      <Illustration />
                    </div>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ol>

      <p className="text-sm text-text-secondary">
        <Link to="/schedule" className="text-accent-strong underline underline-offset-2 hover:no-underline">
          Book a court
        </Link>
        {" · "}
        <Link to="/my-code" className="text-accent-strong underline underline-offset-2 hover:no-underline">
          Your code
        </Link>
      </p>
    </div>
  );
}
