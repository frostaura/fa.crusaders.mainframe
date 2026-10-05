import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { phoneIsOffline, type MemberDoor } from "../lib/api";
import { cn } from "../lib/utils";
import { type LastKnown, minutesSince, readLastKnown } from "../lib/lastKnown";
import {
  CONTACT_UNKNOWN,
  type CodeOnScreen,
  type ContactKnowledge,
  DOOR_SECTION_CHECKING,
  HISTORY_ANCHOR,
  HISTORY_LINK_LABEL,
  decisionActionKinds,
  liveContact,
  staleContact,
} from "../lib/memberDoorCopy";
import { useMemberCode, type MemberCodeView } from "../lib/memberCode/useMemberCode";
import { barredReason, codeUseLine, MY_CODE, newCodeIn } from "../lib/myCodeCopy";
import { useProfileOrNull } from "../components/onboarding/useOnboarding";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { useSplitLayout } from "../components/ui/use-split-layout";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { StateBlock } from "../components/ui/state-block";
import { CodeGroups, MemberCodePass } from "../components/member-code/MemberCodePass";
import { ClubContact } from "../components/member-door/ClubContact";
import { MEMBER_DOOR_LINK_TAPPABLE } from "../components/member-door/links";
import { QrSvg } from "../components/member-door/QrSvg";
import { DecisionCard } from "../components/member-door/DecisionCard";
import { FullScreenQr } from "../components/member-door/FullScreenQr";
import { DoorSection } from "../components/member-door/DoorSection";
import { useBoundaryRefresh } from "../components/member-door/useBoundaryRefresh";
import { useMemberDoor, useShownDecision } from "../components/member-door/useMemberDoor";
import { WhatsNextCard } from "../components/onboarding/WhatsNextCard";
import { GUIDE_FROM_CODE, GUIDE_PATH } from "../lib/onboardingCopy";
import { SetupChecklist } from "../components/onboarding/SetupChecklist";
import { WalletGlance } from "../components/member-code/WalletGlance";

/**
 * My Code — the member's pass, with the ONE rotating code on it (D1, R9, R15: the landing page).
 *
 * <p>
 * <b>One code.</b> The page used to carry a booking code and a member code under two tabs, fetched
 * from the club every minute or so, with a whole apparatus for the moments one had died and the
 * other would have worked. D1 replaced both with a single code made on this phone every thirty
 * seconds from a key it holds (`lib/memberCode/`): it opens the door, lights the member's own court
 * or one they are an accepted partner on, and lets them pay for a friend's court at the box. It needs
 * the network once, to enrol; after that it works with no signal at all, and the page says so
 * with a badge rather than an error. The tabs, the code-died states, the cached booking code and
 * the offline page are gone with the two codes (their tests are retired under D1).
 * </p>
 *
 * <p>
 * <b>The code first.</b> The pass is the first thing under the heading, centred at every width
 * (R9), and nothing that comes and goes above it can move it — a decision about a door renders
 * below it and pins one line to the foot of a phone (D10, R3-29).
 * </p>
 *
 * <p>
 * <b>The door half is unchanged in substance.</b> What the club's doors want, the last decision,
 * the self-check and the club's number are all still here, driven by `/me/door` and its last-known
 * store, and they render with no signal from that store exactly as before.
 * </p>
 */

/** The single code, as the door copy's vocabulary has it: a member code, bounded by no booking. */
const ONE_CODE: CodeOnScreen = { kind: "member" };

function contactFrom(door: MemberDoor | null, remembered: LastKnown["door"]): ContactKnowledge {
  if (door) return liveContact(door.contact);
  if (remembered) return staleContact(remembered.value.contact, minutesSince(remembered.savedAt));
  return CONTACT_UNKNOWN;
}

/**
 * Does this club have a door at all — yes, no, or (when every read has failed and nothing was
 * ever cached) nobody knows. `unknown` is not `no`: a club this phone has never heard anything
 * about is not a club with no door.
 */
function doorsKnowledgeOf(door: MemberDoor | null, remembered: LastKnown["door"], failed: boolean): "yes" | "no" | "unknown" {
  const known = door ? door.doors : remembered?.value.doors === true;
  if (known) return "yes";
  return failed ? "unknown" : "no";
}

/** Every instant `/me/door` has told the page something changes at. D4. */
function boundaryInstants(door: MemberDoor | null): (string | null | undefined)[] {
  const booking = door?.next_booking ?? null;
  return [booking?.ends_at, booking?.door_opens_at, booking?.door_closes_at];
}

/** Everything the page derives from the door read, out of the render for the complexity gate. */
function useDoorFacts(resync: () => Promise<void>, signedIn: boolean) {
  // Signed out (F4.1), the door facts come from the last-known store alone: there is no session
  // to read `/me/door` with, and a refused read would only put a failure beside a good code.
  const doorRead = useMemberDoor(signedIn);
  const door = doorRead.door;
  /** Read once, before the first answer lands, so a no-signal cold start paints something. */
  const [cached] = useState(() => readLastKnown());
  const refreshCode = useCallback(() => { void resync(); }, [resync]);
  // A door that did not recognise the code is the one event that can mean the key on this phone
  // has been rotated (a password change, an admin reset): check with the club now.
  const { shown, dismiss } = useShownDecision(door, refreshCode);
  const remembered = cached.door ?? null;
  const doorsKnowledge = doorsKnowledgeOf(door, remembered, doorRead.failed);
  const doorsClub = doorsKnowledge === "yes";
  // A booking ending or a door window opening changes what the door says, and — for a member
  // whose key the club rotated in the meantime — what the code is; both are asked again.
  useBoundaryRefresh(boundaryInstants(door), useCallback(() => {
    void doorRead.refresh();
    void resync();
  }, [doorRead, resync]));
  const decision = doorsClub ? shown : null;
  return {
    doorRead,
    door,
    cached,
    dismiss,
    refreshCode,
    doorsKnowledge,
    doorsClub,
    decision,
    contact: contactFrom(door, remembered),
    /** D6 — when the door facts on screen were read, when they are no longer the live answer. */
    staleSince: door && doorRead.failure ? doorRead.readAt : null,
    /** The decision card already offers "Book a court"; the standing line then does not. */
    bookingOfferedByCard: decision !== null && decisionActionKinds(decision).includes("book_a_court"),
  };
}

type DoorFacts = ReturnType<typeof useDoorFacts>;

/**
 * The page's columns (R4 form factor, SPEC 3.2), decided by the PAGE's width (`@container/page`),
 * so 200 % text keeps one column.
 *
 * <ul>
 *   <li><b>Phone and tablet:</b> one column in reading order — the pass first (it is the point of
 *   the screen at the court), then setup (while it is unfinished), what it is for, what's next,
 *   the guide, the doors and the way to a human — unchanged; the wallet glance is drawn only beside the pass.</li>
 *   <li><b>60rem:</b> `[pass 24rem] [the rest]`, the pass sticky so it stays in reach while the
 *   door facts scroll.</li>
 *   <li><b>72rem</b> (the `wide` frame from 2xl): the rest splits again —
 *   `[setup + today + doors] [wallet + the way to a human 20rem]`.</li>
 *   <li><b>96rem</b> (the `full` frame from 3xl — Dean, R6: at 1920 the page was an 80rem column,
 *   61 % of the window, its third column holding only "You can spend"): the two columns of the
 *   rest share its width, and "what happens next" moves beside the setup, under the wallet —
 *   `[pass] [setup + doors] [wallet + what happens next + the way to a human]`.</li>
 * </ul>
 * The DOM order is the phone's order in every layout, so Tab order is reading order.
 */
const LAYOUT = "flex flex-col gap-8 @[60rem]/page:grid @[60rem]/page:grid-cols-[24rem_minmax(0,1fr)] @[60rem]/page:items-start";
const PASS_COLUMN = "flex min-w-0 flex-col gap-6 @[60rem]/page:sticky @[60rem]/page:top-6";
const REST = "flex min-w-0 flex-col gap-8 @[72rem]/page:grid @[72rem]/page:items-start";
const REST_COLUMNS = "@[72rem]/page:grid-cols-[minmax(0,1fr)_20rem]";
/** Measured by `useSplitLayout("96rem")`, so the columns and where "what happens next" sits agree. */
const REST_COLUMNS_FULL = "@[72rem]/page:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]";
const COLUMN = "flex min-w-0 flex-col gap-6";

export default function MyCodePage() {
  const view = useMemberCode();
  const facts = useDoorFacts(view.resync, !view.signedOut);
  // The DOM order follows the layout: "what happens next" is in the column it is drawn in.
  const { attach: attachLayout, split: threeColumns } = useSplitLayout("96rem");

  if (view.phase === "barred") {
    return <BarredPage reason={barredReason(view.barredCode ?? "")} checking={view.checking} onCheckAgain={() => void view.resync()} />;
  }

  const code = view.code ? ONE_CODE : null;
  const codeSecondsLeft = view.code ? Math.ceil(view.remainingMs / 1000) : 0;
  const whatsNext = <WhatsNextCard booking={facts.door?.next_booking} timezone={facts.door?.timezone} doors={facts.doorsKnowledge} />;
  // Where "what happens next" stands, and the rest's columns — one decision, from one measure.
  const placed = threeColumns
    ? { inRest: null, inSide: whatsNext, columns: REST_COLUMNS_FULL }
    : { inRest: whatsNext, inSide: null, columns: REST_COLUMNS };

  return (
    // R3-29: the pinned decision line is `position: fixed` at the foot of a phone, so the page
    // owes it room — otherwise the club's own number, the last thing on the page, sits under it.
    // R4 form factor (SPEC 3.2): `content`, and `wide` from 2xl — never `narrow` again; a 512px
    // column left 60 % of a laptop and 73 % of a 1920 screen empty around the pass.
    <PageShell width="content" fullFrom3xl className={cn("2xl:max-w-wide", facts.decision && "pb-24 sm:pb-10")}>
      {/*
        Visually hidden on a phone, and only there (D8: the code first). The pass's own band
        says whose pass it is, the tab bar says "My Code", and at 320x568 with the reader's text
        turned up a visible title was what pushed the symbol below the fold. It is still the
        page's one h1 — the route announcer focuses it and a screen reader lands on it.
      */}
      <PageHeader title={MY_CODE.title} className="sr-only sm:not-sr-only" />

      <div ref={attachLayout} data-my-code-layout="" className={LAYOUT}>
        <div data-my-code-pass="" className={PASS_COLUMN}>
          {view.signedOut && view.phase !== "signed-out" ? <SignedOutNotice /> : null}
          <CodeArea view={view} />
          {facts.decision && (
            <DecisionCard
              decision={facts.decision}
              door={facts.door}
              contact={facts.contact}
              code={code}
              onRefreshCode={facts.refreshCode}
              onDismiss={facts.dismiss}
            />
          )}
        </div>

        <div data-my-code-rest="" className={cn(REST, placed.columns)}>
          <div className={COLUMN}>
            {/* Setup leads the rest (Dean, R5): a to-do list is read first or not at all, and it
                is dismissable (its ×), so it costs a finished member nothing. */}
            {view.signedOut ? null : <SetupChecklist />}
            <p className="text-sm text-text-secondary">{codeUseLine(facts.doorsClub)}</p>
            {placed.inRest}
            <Link to={GUIDE_PATH} className={MEMBER_DOOR_LINK_TAPPABLE}>{GUIDE_FROM_CODE}</Link>
            <DoorBlocks facts={facts} code={code} codeSecondsLeft={codeSecondsLeft} onRefreshCode={view.resync} />
          </div>
          <div data-my-code-side="" className={COLUMN}>
            {/* Beside the pass only: on a phone the chip in the bar already carries the balance. */}
            {view.signedOut ? null : <div className="hidden @[60rem]/page:block"><WalletGlance /></div>}
            {placed.inSide}
            <DoorFooter doorsKnowledge={facts.doorsKnowledge} contact={facts.contact} />
          </div>
        </div>
      </div>
    </PageShell>
  );
}

/**
 * The pass, or the one honest sentence about why there is none.
 *
 * <p>
 * A key on the phone always wins: the pass renders from it whether or not the club answered,
 * with the offline badge when it did not. The other arms exist only for a phone with NO key.
 * </p>
 */
function CodeArea({ view }: { view: MemberCodeView }) {
  if (view.phase === "ready" || view.phase === "loading") return <LivePass view={view} />;
  if (view.phase === "signed-out") {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 pt-6">
          <p className="text-sm text-text-secondary">{MY_CODE.signedOut.noKey}</p>
          <SignInLink />
        </CardContent>
      </Card>
    );
  }
  if (view.phase === "needs-signal") {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 pt-6">
          {/* R15 X15-3 — "needs signal" only when the phone has none; else the club is unreachable. */}
          <h2 className="text-base font-semibold text-text-primary">{firstVisit().title}</h2>
          <p className="text-sm text-text-secondary">{firstVisit().body}</p>
          <Button variant="outline" pending={view.checking} onClick={() => void view.resync()}>{MY_CODE.tryAgain}</Button>
        </CardContent>
      </Card>
    );
  }
  if (view.phase === "unavailable") {
    return <p role="status" className="text-sm text-text-secondary">{MY_CODE.unavailable}</p>;
  }
  return <StateBlock error={view.error} action="set up your code" onRetry={() => void view.resync()} />;
}

/** Back to /login, and back here after it (RequireAuth's own `from` shape). */
function SignInLink() {
  return (
    <Button asChild variant="outline">
      <Link to="/login" state={{ from: { pathname: "/my-code" } }}>{MY_CODE.signedOut.signIn}</Link>
    </Button>
  );
}

/** F4.1 — signed out, code still good: one calm line and the way back in. */
function SignedOutNotice() {
  return (
    <div role="status" className="flex flex-col items-start gap-3 rounded-lg bg-bg-muted px-4 py-3 text-sm text-text-secondary">
      <p>{MY_CODE.signedOut.body}</p>
      <SignInLink />
    </div>
  );
}

/** The pass, and the full-screen view it opens. */
function LivePass({ view }: { view: MemberCodeView }) {
  const profile = useProfileOrNull();
  const [full, setFull] = useState(false);
  const token = view.code?.token ?? null;
  /**
   * Focus goes back to the QR when the full-screen view closes (R3-10): Escape, Done and the
   * hardware back button all used to leave it on `<body>`, which for a keyboard user is the top
   * of the document and for a screen-reader user is silence.
   */
  const trigger = useRef<HTMLButtonElement | null>(null);
  const wasFull = useRef(false);
  useEffect(() => {
    if (wasFull.current && !full) trigger.current?.focus();
    wasFull.current = full;
  }, [full]);

  return (
    <>
      <MemberCodePass
        token={token}
        remainingMs={view.remainingMs}
        offline={view.offline}
        memberName={profile?.full_name?.trim() || null}
        photoUrl={profile?.photo_url ?? null}
        onOpenFullScreen={() => setFull(true)}
        triggerRef={trigger}
      />
      {full && token && (
        <FullScreenQr
          code={token}
          codeText={<CodeGroups token={token} />}
          countdown={newCodeIn(Math.ceil(view.remainingMs / 1000))}
          hint={MY_CODE.brightnessHint}
          onClose={() => setFull(false)}
        >
          <QrSvg value={token} className="h-full w-full" />
        </FullScreenQr>
      )}
    </>
  );
}

/**
 * What a member the club has barred sees instead of a code — the whole page, because everything
 * else on it is an invitation to hold up a code the club has said no to. "Check again" rather than
 * "Refresh": what is re-tested is the club's decision, not the network.
 */
function BarredPage({ reason, checking, onCheckAgain }: { reason: string; checking: boolean; onCheckAgain: () => void }) {
  return (
    <PageShell width="narrow">
      <PageHeader title={MY_CODE.title} />
      <Card>
        <CardContent className="flex flex-col items-start gap-3 pt-6">
          <p role="alert" className="text-sm text-danger-strong">{reason}</p>
          <p className="text-sm text-text-secondary">{MY_CODE.barredNoCode}</p>
          <Button variant="outline" pending={checking} onClick={onCheckAgain}>{MY_CODE.checkAgain}</Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/**
 * Everything on the page that exists only because the club has a door — and the one sentence
 * for the seconds before the page knows whether it has. One component, one guard: a page that
 * says something about doors at a club with none is the failure this surface is designed around.
 */
function DoorBlocks(props: { facts: DoorFacts; code: CodeOnScreen | null; codeSecondsLeft: number; onRefreshCode: () => Promise<void> }) {
  const { facts, code, codeSecondsLeft, onRefreshCode } = props;
  if (!facts.doorsClub && facts.doorsKnowledge !== "unknown") {
    // D9 — while the read that answers "does this club have a door" is in flight, one muted line
    // that is true whichever way the answer comes back.
    if (!facts.doorRead.loading) return null;
    return <p className="text-sm text-text-muted">{DOOR_SECTION_CHECKING}</p>;
  }
  return (
    <DoorSection
      door={facts.door}
      cached={facts.cached}
      doorRead={facts.doorRead}
      contact={facts.contact}
      code={code}
      staleSince={facts.staleSince}
      codeSecondsLeft={codeSecondsLeft}
      onRefreshCode={onRefreshCode}
      actionOfferedAbove={facts.bookingOfferedByCard}
    />
  );
}

/** The way to the member's own door record, and the way to a human. "Unknown" is not "no" (D1). */
function DoorFooter({ doorsKnowledge, contact }: { doorsKnowledge: "yes" | "no" | "unknown"; contact: ContactKnowledge }) {
  if (doorsKnowledge === "no") return null;
  return (
    <>
      <Link to={`/profile#${HISTORY_ANCHOR}`} className={MEMBER_DOOR_LINK_TAPPABLE}>{HISTORY_LINK_LABEL}</Link>
      <ClubContact contact={contact} />
    </>
  );
}

/** R15 X15-3 — the first visit's words: no signal on the phone, or a club it cannot reach. */
function firstVisit(): { title: string; body: string } {
  return phoneIsOffline() ? MY_CODE.needsSignal : MY_CODE.needsClub;
}
