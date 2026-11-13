import { Link } from "react-router-dom";
import {
  ArrowSquareOut, CalendarDots, FacebookLogo, InstagramLogo, MapPin, Trophy, Users,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { CrestMark } from "@/components/shell/Crest";
import { AppExplainer, CourtMotif } from "@/components/landing/LandingParts";


/**
 * Crusaders Squash's own public page (go-live FM-8: one club's content, chosen by its slug in
 * `pages/Home`, not the page every club is shown).
 *
 * The club's front door, and — while both of Northwood Crusaders' own domains are parked — very
 * possibly the only working page about Crusaders squash on the internet.
 *
 * <p>
 * It replaced a page that showed a member of a squash club FrostAura's internal positioning
 * ("Multi-tenant SaaS for racquet-sport clubs; first customer is Crusaders Squash Club") above
 * two bare text links. Nothing on it said squash, nothing said Durban, and the two things a
 * visitor actually came to do did not look like controls at all.
 * </p>
 *
 * <h3>Every fact here is sourced, and the gaps are deliberate</h3>
 * <p>
 * What is on this page is what could be verified against the club's own copy (via the Wayback
 * Machine, since crusaderssportsclub.co.za is currently parked), its live booking system at
 * squashman.com/CRU, SportyHQ's league data, and SquashSA's tournament calendar.
 * </p>
 * <p>
 * What is deliberately ABSENT matters as much, because each one is tempting and none of it
 * could be established:
 * </p>
 * <ul>
 *   <li><b>No phone number.</b> The club's own contact page gives two that differ by one digit
 *       (076 226 1390 in the body, 076 226 7390 in the footer), and older pages give a third.
 *       Publishing a wrong number for a club is worse than publishing none.</li>
 *   <li><b>No membership fees.</b> Never published anywhere; the club's membership page only
 *       ever offered a downloadable form, and that file is not archived.</li>
 *   <li><b>No club night.</b> League nights are documented. A social/club night is not, and
 *       league nights are not the same thing.</li>
 *   <li><b>Not "air-conditioned".</b> The club says "ultramodern glass-back"; nothing anywhere
 *       mentions climate control. It is the single most tempting unsupported detail.</li>
 *   <li><b>No named individuals.</b> The squash contact has changed almost every year, and
 *       several of the addresses in circulation are personal Gmail accounts.</li>
 *   <li><b>No link to crusaderssquash.co.za.</b> That domain belongs to a DIFFERENT and
 *       unrelated Crusaders Squash Club in Gqeberha, Eastern Cape. It is the top search result
 *       for the name, and it is the wrong club.</li>
 * </ul>
 */

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-surface p-4">
      <p className="text-2xl font-bold tracking-tight text-accent-strong">{value}</p>
      <p className="mt-0.5 break-words text-sm text-text-secondary">{label}</p>
    </div>
  );
}

/** A landing card: the design-system card with its content gutter. */
/**
 * R4 (V4-2 / X4-7): a contact link is a 44px target, and its words wrap. At 200 % text the address
 * and the handle are each one unbreakable "word" wider than a phone, and the page scrolled sideways
 * (85px at 390, 155 at 320). The icon is rem-sized so it grows with the words beside it.
 */
const CONTACT_LINK = "inline-flex min-h-touch max-w-full items-center gap-2 py-2 text-accent-strong underline underline-offset-2 hover:no-underline";

function Panel({ children }: { children: React.ReactNode }) {
  return <Card><CardContent>{children}</CardContent></Card>;
}

/** League nights, from the KZN Squash league rules cross-checked against the 2026 fixture dates. */
const LEAGUE_NIGHTS: { night: string; who: string }[] = [
  { night: "Monday", who: "Ladies 1st Division · Racketball from 5:30pm" },
  { night: "Tuesday", who: "Men's 1st – 4th Division" },
  { night: "Wednesday", who: "Men's 5th – 7th Division" },
  { night: "Thursday", who: "Men's 8th – 9th Division" },
];


export function CrusadersLanding() {
  return (
    // Owns its own gutter and width cap, because Layout gives the public landing a bare,
    // full-bleed <main> rather than the app's boxed content column.
    // R4 form factor (SPEC 3.18): the 120rem frame from 2xl, where the hero splits wide, the club's
    // three blocks share one row and the court plan is drawn large rather than as a 60px icon.
    <div className="mx-auto w-full max-w-content space-y-10 px-4 py-10 sm:space-y-14 sm:px-6 sm:py-14 lg:px-8 2xl:max-w-page 3xl:px-12">
      {/* ---- Hero ---------------------------------------------------------------- */}
      <header className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[1fr_auto] 2xl:gap-16">
        <div>
          <CrestMark className="mb-4 h-14 w-12" />
          <p className="text-sm font-medium uppercase tracking-wider text-accent-strong">
            Durban North · KwaZulu-Natal
          </p>
          {/* R4: never wider than a phone — at 200 % text "Crusaders" alone was wider than a 320px
              screen. 13vw is above 1.875rem at every phone width at normal text, so only large
              text is capped. */}
          <h1 className="mt-1 font-display text-[length:min(1.875rem,13vw)] font-bold leading-tight tracking-tight sm:text-4xl 2xl:text-5xl">
            Crusaders Squash
          </h1>
          {/*
            "since the mid-1960s" belongs to Northwood Crusaders Sports Club, the parent club
            with the rugby, hockey and cricket sections. Written as it was — inside a paragraph
            headed "Crusaders Squash" — it read as the founding date of the squash section,
            which is not what the source says and is not known.
          */}
          <p className="mt-3 max-w-prose text-base text-text-secondary 2xl:text-lg">
            Four glass-back courts, thirteen league teams, and squash at Northwood Crusaders
            Sports Club — part of Durban North since the mid-1960s. Book a court, buy court
            minutes and check your league night — all from here.
          </p>

          {/* The two things a visitor came to do. Buttons, not the pair of bare text links this
              page used to offer. */}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg"><Link to="/login">Sign in</Link></Button>
            <Button asChild size="lg" variant="outline"><Link to="/register">Join the club</Link></Button>
          </div>
        </div>

        {/* Decorative at small sizes, where the copy and the buttons are the whole job. */}
        <CourtMotif className="hidden h-56 w-auto justify-self-end sm:block 2xl:h-96" />
      </header>

      {/* ---- The four claims that are strongest and best-sourced ------------------ */}
      <section aria-labelledby="at-a-glance">
        <h2 id="at-a-glance" className="sr-only">The club at a glance</h2>
        {/* R4: as many 8rem columns as fit — two on a phone, four on a desktop, and ONE at 200 %
            text on a 320px phone, where "racketball" ran off a half-width cell. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
          <Stat value="4" label="Glass-back courts" />
          <Stat value="13" label="League teams, across 10 divisions" />
          <Stat value="2025" label="KZN 1st Division champions" />
          <Stat value="3" label="Formats: singles, doubles, racketball" />
        </div>
      </section>

      {/* League, the Open and what the app is for: stacked, then ONE three-column row from 2xl. */}
      <div className="grid gap-10 sm:gap-14 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] 2xl:items-start 2xl:gap-6">
      {/* ---- League ---------------------------------------------------------------- */}
      <section aria-labelledby="league" className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <h2 id="league" className="flex items-center gap-2 text-lg font-semibold">
            <Trophy size={20} className="text-accent-strong" aria-hidden="true" />
            League squash
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            Crusaders field thirteen teams across ten divisions of the KZN Squash League — the
            largest presence of any club in the province. The first team won the 1st Division in
            2025, and the club took the 2nd Division the same season.
          </p>
          <dl className="mt-4 divide-y divide-border border-t border-border">
            {LEAGUE_NIGHTS.map(({ night, who }) => (
              <div key={night} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
                <dt className="text-sm font-medium">{night}</dt>
                <dd className="text-sm text-text-secondary">{who}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-text-muted">
            League fixtures start at 6pm. The season runs from about April to November.
          </p>
        </Panel>

        <Panel>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CalendarDots size={20} className="text-accent-strong" aria-hidden="true" />
            The Crusaders Open
          </h2>
          {/*
            "— the largest purse in the event's recorded history" used to end this sentence.
            Nothing found supports it: prize money for earlier editions is not published
            anywhere that was checked, so it is not a fact that went unverified, it is one that
            cannot be checked at all. The R25 000 is sourced and stays.
          */}
          <p className="mt-2 text-sm text-text-secondary">
            The club hosts the Crusaders Open each March, a tournament on Squash South Africa's
            calendar. The 2026 edition ran from 5 to 8 March with R25 000 in prize money.
          </p>
          <h3 className="mt-5 flex items-center gap-2 text-base font-semibold">
            <Users size={20} className="text-accent-strong" aria-hidden="true" />
            New to squash?
          </h3>
          <p className="mt-2 text-sm text-text-secondary">
            In the club's own words, it welcomes <em>"all levels of players, from beginners to
            experienced, and from kids to adults"</em>. Coaching is available, and there is a free
            coaching clinic for members' children. Northwood School plays its squash here too.
          </p>
        </Panel>
      </section>

      {/* ---- What this app is for (shared with every club's landing) ---------- */}
      <AppExplainer>
        <span className="inline-flex items-center gap-1.5"><CalendarDots size={16} aria-hidden="true" /> Courts bookable through the day, seven days a week in season</span>
      </AppExplainer>
      </div>

      {/* ---- Find us ---------------------------------------------------------------- */}
      <section aria-labelledby="find-us" className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <h2 id="find-us" className="flex items-center gap-2 text-lg font-semibold">
            <MapPin size={20} className="text-accent-strong" aria-hidden="true" />
            Where to find us
          </h2>
          <address className="mt-2 not-italic text-sm text-text-secondary">
            Crusaders Squash Club<br />
            Northwood Crusaders Sports Club<br />
            10 Ranleigh Crescent<br />
            Durban North, KwaZulu-Natal 4051
          </address>
          <p className="mt-3 text-sm text-text-secondary">
            Squash is one section of Northwood Crusaders Sports Club, which also fields rugby,
            hockey, mini rugby and cricket, and has a bar, a kitchen and a beer garden.
          </p>
          <a
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent-strong underline underline-offset-2 hover:no-underline"
            href="https://maps.google.com/?cid=12190854373719358442"
            target="_blank"
            rel="noreferrer noopener"
          >
            Open in Google Maps <ArrowSquareOut size={16} aria-hidden="true" />
          </a>
        </Panel>

        <Panel>
          <h2 className="text-lg font-semibold">Get in touch</h2>
          <p className="mt-2 text-sm text-text-secondary">
            For membership, fees and coaching, the club is the place to ask — those are not
            published online.
          </p>
          <ul className="mt-4 flex flex-col gap-1 text-sm">
            <li>
              <a className={cn(CONTACT_LINK, "font-medium")} href="mailto:info@northwoodcrusaders.co.za">
                <span className="min-w-0 [overflow-wrap:anywhere]">info@northwoodcrusaders.co.za</span>
              </a>
            </li>
            <li>
              <a className={CONTACT_LINK}
                 href="https://www.facebook.com/northwoodcrusaders/" target="_blank" rel="noreferrer noopener">
                <FacebookLogo aria-hidden="true" className="size-5 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">Northwood Crusaders on Facebook</span>
              </a>
            </li>
            <li>
              {/*
                SINGULAR. The club's own website footer links @northwoodcrusaderssports — plural —
                which is a dead account with no posts. This is the live one.
              */}
              <a className={CONTACT_LINK}
                 href="https://www.instagram.com/northwoodcrusaderssport/" target="_blank" rel="noreferrer noopener">
                <InstagramLogo aria-hidden="true" className="size-5 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">@northwoodcrusaderssport</span>
              </a>
            </li>
            <li>
              {/*
                UNVERIFIED, and deliberately recorded as such.

                The other three links on this page were opened and confirmed. This one cannot
                be: Facebook redirects a signed-out visitor to a login wall and answers 200
                while doing it, so neither a status code nor a page fetch distinguishes "this
                group exists and is the club's" from "this group was deleted years ago". The id
                came from a search result, not from the club's own site, which is a weaker
                source than everything else here.

                Left in place rather than removed — a members' group is genuinely useful and
                the id is plausible — but somebody at the club should open it once and either
                delete this comment or delete the link.
              */}
              <a className={CONTACT_LINK}
                 href="https://www.facebook.com/groups/235624123200990/" target="_blank" rel="noreferrer noopener">
                <FacebookLogo aria-hidden="true" className="size-5 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">Crusaders Squash &amp; Racketball group</span>
              </a>
            </li>
          </ul>
        </Panel>
      </section>
    </div>
  );
}
