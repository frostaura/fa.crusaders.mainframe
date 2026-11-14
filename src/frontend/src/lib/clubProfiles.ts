/**
 * What a club's own sign-in panel says about it beyond its name — the place and a few sourced facts
 * (go-live FM-8), keyed by the club's slug.
 *
 * <p>
 * <b>Content, not code.</b> These sentences were literals in `authCopy` and the sign-in panel, so
 * every club's panel described Crusaders. They are per-club content now, chosen by the slug the
 * API names (`lib/clubIdentity`); a club with no entry gets {@link GENERIC_FACTS}, true at every
 * club, and no place line rather than somebody else's. The day the API serves a club profile this
 * table is that profile's fallback, and then goes.
 * </p>
 */
export type ClubProfile = { place: string; facts: readonly string[] };

const PROFILES: Readonly<Record<string, ClubProfile>> = {
  // The three facts the club's public page makes and sources (pages/Home's Crusaders landing).
  crusaders: {
    place: "Northwood Crusaders · Durban North",
    facts: [
      "Four glass-back courts",
      "Thirteen league teams across ten divisions",
      "Book a court and light it from your phone",
    ],
  },
};

/** True of every club this product serves: what the app is for. */
export const GENERIC_FACTS: readonly string[] = [
  "Book a court from your phone",
  "Buy minutes once, spend them on any court",
  "Switch the court lights on with your code",
];

export function clubProfile(slug: string | null | undefined): ClubProfile | null {
  return slug ? PROFILES[slug] ?? null : null;
}
