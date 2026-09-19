import { Link } from "react-router-dom";
import {
  CalendarDays, ExternalLink, Facebook, Instagram, MapPin, QrCode, Trophy, Users, Wallet,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";
// doors: admin
import { AdminDoorsHomeRow } from "../components/doors/AdminDoorsHomeRow";

/**
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

/** A plain squash court, drawn rather than photographed — no usable court photography exists. */
function CourtMotif({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 240" className={className} role="img" aria-label="A squash court, seen from above">
      {/*
        The floor is FILLED rather than outlined. Drawn as an outline it read as an empty white
        rectangle with some lines near the bottom — indistinguishable from an image that had
        failed to load, which is a poor thing to put beside a hero.
      */}
      <rect x="4" y="4" width="152" height="232" rx="6" className="fill-accent-soft stroke-accent-strong" strokeWidth="1.5" strokeOpacity="0.45" />
      {/* Short line, half-court line and the two service boxes — a singles court's markings. */}
      <line x1="4" y1="148" x2="156" y2="148" className="stroke-accent-strong" strokeWidth="1.5" strokeOpacity="0.55" />
      <line x1="80" y1="148" x2="80" y2="236" className="stroke-accent-strong" strokeWidth="1.5" strokeOpacity="0.55" />
      <rect x="4" y="148" width="50" height="50" className="fill-bg-surface stroke-accent-strong" strokeWidth="1.5" strokeOpacity="0.55" fillOpacity="0.65" />
      <rect x="106" y="148" width="50" height="50" className="fill-bg-surface stroke-accent-strong" strokeWidth="1.5" strokeOpacity="0.55" fillOpacity="0.65" />
      {/* The tin, across the front wall — the one red line on a squash court, and the club's
          own second colour. */}
      <line x1="4" y1="18" x2="156" y2="18" className="stroke-danger-strong" strokeWidth="5" strokeOpacity="0.75" strokeLinecap="round" />
      {/* The ball, mid-rally. Small, off-centre, and the only thing suggesting movement. */}
      <circle cx="104" cy="92" r="5" className="fill-accent-strong" fillOpacity="0.8" />
    </svg>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-surface p-4">
      <p className="text-2xl font-bold tracking-tight text-accent-strong">{value}</p>
      <p className="mt-0.5 text-sm text-text-secondary">{label}</p>
    </div>
  );
}

/** League nights, from the KZN Squash league rules cross-checked against the 2026 fixture dates. */
const LEAGUE_NIGHTS: { night: string; who: string }[] = [
  { night: "Monday", who: "Ladies 1st Division · Racketball from 5:30pm" },
  { night: "Tuesday", who: "Men's 1st – 4th Division" },
  { night: "Wednesday", who: "Men's 5th – 7th Division" },
  { night: "Thursday", who: "Men's 8th – 9th Division" },
];

function SignedOutLanding() {
  return (
    // Owns its own gutter and width cap, because Layout gives the public landing a bare,
    // full-bleed <main> rather than the app's boxed content column.
    <div className="mx-auto w-full max-w-5xl space-y-10 px-4 py-10 sm:space-y-14 sm:py-14">
      {/* ---- Hero ---------------------------------------------------------------- */}
      <header className="grid items-center gap-6 sm:grid-cols-[1fr_auto]">
        <div>
          <p className="text-sm font-medium uppercase tracking-wider text-accent-strong">
            Durban North · KwaZulu-Natal
          </p>
          <h1 className="mt-1 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
            Crusaders Squash
          </h1>
          {/*
            "since the mid-1960s" belongs to Northwood Crusaders Sports Club, the parent club
            with the rugby, hockey and cricket sections. Written as it was — inside a paragraph
            headed "Crusaders Squash" — it read as the founding date of the squash section,
            which is not what the source says and is not known.
          */}
          <p className="mt-3 max-w-prose text-base text-text-secondary">
            Four glass-back courts, thirteen league teams, and squash at Northwood Crusaders
            Sports Club — part of Durban North since the mid-1960s. Book a court, top up your
            credits and check your league night — all from here.
          </p>

          {/* The two things a visitor came to do. Buttons, not the pair of bare text links this
              page used to offer. */}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              to="/login"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-strong px-6 font-medium text-white hover:opacity-90"
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-accent-strong px-6 font-medium text-accent-strong hover:bg-accent-soft"
            >
              Join the club
            </Link>
          </div>
        </div>

        {/* Decorative at small sizes, where the copy and the buttons are the whole job. */}
        <CourtMotif className="hidden h-56 w-auto justify-self-end sm:block" />
      </header>

      {/* ---- The four claims that are strongest and best-sourced ------------------ */}
      <section aria-labelledby="at-a-glance">
        <h2 id="at-a-glance" className="sr-only">The club at a glance</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat value="4" label="Glass-back courts" />
          <Stat value="13" label="League teams, across 10 divisions" />
          <Stat value="2025" label="KZN 1st Division champions" />
          <Stat value="3" label="Formats: singles, doubles, racketball" />
        </div>
      </section>

      {/* ---- League ---------------------------------------------------------------- */}
      <section aria-labelledby="league" className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 id="league" className="flex items-center gap-2 text-lg font-semibold">
            <Trophy size={18} className="text-accent-strong" aria-hidden="true" />
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
        </Card>

        <Card>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CalendarDays size={18} className="text-accent-strong" aria-hidden="true" />
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
            <Users size={18} className="text-accent-strong" aria-hidden="true" />
            New to squash?
          </h3>
          <p className="mt-2 text-sm text-text-secondary">
            In the club's own words, it welcomes <em>"all levels of players, from beginners to
            experienced, and from kids to adults"</em>. Coaching is available, and there is a free
            coaching clinic for members' children. Northwood School plays its squash here too.
          </p>
        </Card>
      </section>

      {/* ---- What this app is for -------------------------------------------------- */}
      <section aria-labelledby="mainframe" className="rounded-lg border border-border bg-bg-muted p-5 sm:p-6">
        <h2 id="mainframe" className="text-lg font-semibold">Booking, credits and court lights</h2>
        {/*
          What the member actually does, which is not what this paragraph used to say.

          It read "Your booking turns the court lights on when you arrive, so there is no key to
          collect and nothing to switch on yourself." There is no such thing in this product. A
          booking earns the member a short-lived code; they hold its QR up to the scanner on the
          court box, or type the twelve characters, and THAT is what raises the lights. The
          signed-in home page one screen away says so — "Show this at the court to turn the
          lights on" — and so does /court-code, so the public page was the only surface making
          the claim and it contradicted both of them. Somebody who read it would stand on a dark
          court waiting for it to notice them.

          The slice length is also not stated any more. `slice_minutes` is per-tenant
          configuration (the default is 15) and this page is signed out, so it cannot read it —
          a club that sets 20 would have a public page quietly advertising the wrong thing.
        */}
        <p className="mt-2 max-w-prose text-sm text-text-secondary">
          Members book courts here in short slices, paid from a credit balance you top up in the
          app — there is no key to collect and nothing to pay at the door. When you get to the
          court, hold your code up to the scanner on the court box and the lights come on for
          your slot.
        </p>
        {/*
          The opening hours are gone, and deliberately.

          This said "Courts bookable 6:30am – 10pm on weekdays", which was wrong twice. The
          club's configured hours run from 06:00, not 06:30 — and it is open on SATURDAY,
          07:00 to 20:00, which the line omitted entirely. A visitor reading it concluded the
          courts were shut at the weekend. Both numbers are `operating_hours` in tenant
          settings, editable from Admin → Settings, and a signed-out page has no endpoint that
          serves them; there is nothing to state here that is both specific and reliably true.
        */}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-text-secondary">
          <span className="inline-flex items-center gap-1.5"><CalendarDays size={15} aria-hidden="true" /> Courts bookable through the day, seven days a week in season</span>
          <span className="inline-flex items-center gap-1.5"><Wallet size={15} aria-hidden="true" /> Pay from credits, not at the door</span>
        </div>
      </section>

      {/* ---- Find us ---------------------------------------------------------------- */}
      <section aria-labelledby="find-us" className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 id="find-us" className="flex items-center gap-2 text-lg font-semibold">
            <MapPin size={18} className="text-accent-strong" aria-hidden="true" />
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
            Open in Google Maps <ExternalLink size={14} aria-hidden="true" />
          </a>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold">Get in touch</h2>
          <p className="mt-2 text-sm text-text-secondary">
            For membership, fees and coaching, the club is the place to ask — those are not
            published online.
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            <li>
              <a className="inline-flex items-center gap-2 font-medium text-accent-strong underline underline-offset-2 hover:no-underline"
                 href="mailto:info@northwoodcrusaders.co.za">
                info@northwoodcrusaders.co.za
              </a>
            </li>
            <li>
              <a className="inline-flex items-center gap-2 text-accent-strong underline underline-offset-2 hover:no-underline"
                 href="https://www.facebook.com/northwoodcrusaders/" target="_blank" rel="noreferrer noopener">
                <Facebook size={15} aria-hidden="true" /> Northwood Crusaders on Facebook
              </a>
            </li>
            <li>
              {/*
                SINGULAR. The club's own website footer links @northwoodcrusaderssports — plural —
                which is a dead account with no posts. This is the live one.
              */}
              <a className="inline-flex items-center gap-2 text-accent-strong underline underline-offset-2 hover:no-underline"
                 href="https://www.instagram.com/northwoodcrusaderssport/" target="_blank" rel="noreferrer noopener">
                <Instagram size={15} aria-hidden="true" /> @northwoodcrusaderssport
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
              <a className="inline-flex items-center gap-2 text-accent-strong underline underline-offset-2 hover:no-underline"
                 href="https://www.facebook.com/groups/235624123200990/" target="_blank" rel="noreferrer noopener">
                <Facebook size={15} aria-hidden="true" /> Crusaders Squash &amp; Racketball group
              </a>
            </li>
          </ul>
        </Card>
      </section>
    </div>
  );
}

function SignedInHome({ isAdmin }: { isAdmin: boolean }) {
  const links = [
    { to: "/schedule", label: "Book a court", hint: "Today's grid across all four courts", icon: CalendarDays, primary: true },
    // QrCode, not Trophy. The court code IS a QR code shown at the court; a trophy beside it
    // says "achievement", which is a different thing entirely and the only icon on this screen
    // that pointed at the wrong idea.
    { to: "/court-code", label: "Your court code", hint: "Show this at the court to turn the lights on", icon: QrCode },
    { to: "/wallet", label: "Wallet", hint: "Balance, top-ups and charges", icon: Wallet },
    ...(isAdmin ? [{ to: "/admin/members", label: "Admin · Members", hint: "Approve applications and manage members", icon: Users }] : []),
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Crusaders Squash</h1>
        <p className="mt-1 text-text-secondary">What would you like to do?</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {/* doors: admin — one row, and ONLY when a door is silent, shut or unnamed (A2.6).
            On a normal day Home says nothing about doors at all: P7 is a rule about email and
            it is the right rule for a home screen too, because a panel that is always there is
            one an admin skims past and is therefore worth nothing on the morning it matters.
            The component renders null unless there is something to act on, and a failed read
            renders null too. */}
        {isAdmin && <AdminDoorsHomeRow />}
        {links.map(({ to, label, hint, icon: Icon, primary }) => (
          <Link
            key={to}
            to={to}
            className={
              "flex items-start gap-3 rounded-lg border p-4 " +
              (primary
                ? "border-accent-strong bg-accent-soft"
                : "border-border bg-bg-surface hover:bg-bg-muted")
            }
          >
            <Icon size={20} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden="true" />
            <span>
              <span className="block font-medium">{label}</span>
              <span className="block text-sm text-text-secondary">{hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const auth = useAuth();
  return auth.status === "authenticated"
    ? <SignedInHome isAdmin={auth.isAdmin} />
    : <SignedOutLanding />;
}
