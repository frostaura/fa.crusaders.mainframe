import { Link, Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { tokenStore } from "@/lib/api";
import { useClubIdentity } from "@/lib/clubIdentity";
import { useAuth } from "../lib/useAuth";
import { CrestMark } from "../components/shell/Crest";
import { LANDING_PATH } from "../components/shell/nav";
import { AppExplainer, CourtMotif } from "../components/landing/LandingParts";
import { CrusadersLanding } from "../clubs/crusaders/CrusadersLanding";

/**
 * Go-live FM-8 — the public page is the CLUB's, and which club is tenant data. Crusaders' own page
 * (its league, its Open, its address) was the page every club's address served. A club with a page
 * of its own is listed here by slug; every other club gets {@link ClubLanding}, which says only
 * what is true at any club, under that club's own name.
 */
const CLUB_LANDINGS: Readonly<Record<string, () => React.ReactElement>> = {
  crusaders: CrusadersLanding,
};

export const HOME_COPY = {
  /** The heading while the club's name is unknown (a first visit whose read failed). */
  unnamed: "Book a court",
  lead: "Book a court, buy court minutes and switch the court lights on — all from here.",
  signIn: "Sign in",
  join: "Join the club",
} as const;

/** Any club's public page: its name, the two things a visitor came to do, and what the app is for. */
export function ClubLanding({ name }: { name: string | null }) {
  return (
    <div className="mx-auto w-full max-w-content space-y-10 px-4 py-10 sm:space-y-14 sm:px-6 sm:py-14 lg:px-8 2xl:max-w-page 3xl:px-12">
      <header className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[1fr_auto] 2xl:gap-16">
        <div>
          <CrestMark className="mb-4 h-14 w-12" />
          <h1 className="mt-1 font-display text-[length:min(1.875rem,13vw)] font-bold leading-tight tracking-tight sm:text-4xl 2xl:text-5xl">
            {name ?? HOME_COPY.unnamed}
          </h1>
          <p className="mt-3 max-w-prose text-base text-text-secondary 2xl:text-lg">{HOME_COPY.lead}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg"><Link to="/login">{HOME_COPY.signIn}</Link></Button>
            <Button asChild size="lg" variant="outline"><Link to="/register">{HOME_COPY.join}</Link></Button>
          </div>
        </div>
        <CourtMotif className="hidden h-56 w-auto justify-self-end sm:block 2xl:h-96" />
      </header>
      <AppExplainer />
    </div>
  );
}

/** Whose page to draw: the club's own, the generic one, or its shape while the first read is out. */
function SignedOutLanding() {
  const { club, settled } = useClubIdentity();
  const Own = club ? CLUB_LANDINGS[club.slug] : undefined;
  if (Own) return <Own />;
  if (!club && !settled) {
    return (
      <div aria-busy="true" className="mx-auto w-full max-w-content space-y-4 px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Skeleton className="h-14 w-12" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-full max-w-prose" />
      </div>
    );
  }
  return <ClubLanding name={club?.name ?? null} />;
}


/**
 * "/" — the club's public page for a visitor, and the way in for a member.
 *
 * <p>
 * R15: a signed-in member lands on My Code, so "/" sends them there rather than to a second home
 * screen that repeated the tab bar as tiles. The signed-in home (its tiles, and the admin's doors
 * row) is retired with it; the "what happens next" card already lives on My Code.
 * </p>
 *
 * <p>
 * <b>Also while the session is unconfirmed.</b> A stored token during the first probe, or a
 * session the club cannot be reached to confirm (offline), goes straight to My Code too: that
 * route's own guard decides what it may show — the member's last-known code with no signal (D3),
 * the connection notice, or sign-in if the token turns out to be refused. Showing the marketing
 * page to a member standing at a locked door with no signal would be the worst answer of the
 * four.
 * </p>
 */
export default function HomePage() {
  const auth = useAuth();
  const holdsSession = auth.status === "authenticated"
    || ((auth.status === "loading" || auth.status === "offline") && Boolean(tokenStore.get()));
  if (holdsSession) return <Navigate to={LANDING_PATH} replace />;
  return <SignedOutLanding />;
}
