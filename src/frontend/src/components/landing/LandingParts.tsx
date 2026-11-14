import type { ReactNode } from "react";
import { Wallet } from "@/components/ui/icons";

/**
 * The parts of a club's public page that are true at every club (go-live FM-8): the drawn court,
 * and what the app is for. A club's own landing (`clubs/<slug>/`) and the generic one in
 * `pages/Home` both draw them, so the product's one description of itself cannot drift between
 * clubs.
 */

/** A plain squash court, drawn rather than photographed — no usable court photography exists. */
export function CourtMotif({ className }: { className?: string }) {
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

/**
 * What the member actually does with the app, said the same way at every club. `children` adds a
 * club's own facts to the row under it (Crusaders: when its courts are bookable).
 */
export function AppExplainer({ children }: { children?: ReactNode }) {
  return (
    <section aria-labelledby="mainframe" className="rounded-lg border border-border bg-bg-muted p-5 sm:p-6">
      <h2 id="mainframe" className="text-lg font-semibold">Booking, minutes and court lights</h2>
      {/*
        What the member actually does, which is not what this paragraph used to say.

        It read "Your booking turns the court lights on when you arrive, so there is no key to
        collect and nothing to switch on yourself." There is no such thing in this product. A
        booking earns the member a short-lived code; they hold its QR up to the scanner on the
        court box, or type the twelve characters, and THAT is what raises the lights. The
        signed-in home page one screen away says so — its tile points at the court box — and
        so does /my-code, so the public page was the only surface making the claim and it
        contradicted both of them. Somebody who read it would stand on a dark court waiting
        for it to notice them.

        The slice length is also not stated any more. `slice_minutes` is per-tenant
        configuration (the default is 15) and this page is signed out, so it cannot read it —
        a club that sets 20 would have a public page quietly advertising the wrong thing.
      */}
      <p className="mt-2 max-w-prose text-sm text-text-secondary">
        Members book courts here in short slices, paid in minutes from a balance you buy in
        packages in the app — a booking costs exactly its length, there is no key to collect
        and nothing to pay at the door. When you get to the
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
        {children}
        <span className="inline-flex items-center gap-1.5"><Wallet size={16} aria-hidden="true" /> Pay in minutes, not at the door</span>
      </div>
    </section>
  );
}
