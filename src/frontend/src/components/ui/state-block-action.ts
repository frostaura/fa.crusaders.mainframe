/**
 * R1 (F3 follow-up) — what a read is, as ONE verb phrase that must read after "Couldn't" — "read
 * the fault list", "load your wallet". The loading sentence is derived from it ("Reading the fault
 * list…"), so a call site can no longer hand over a noun phrase for one sentence and get "Reading
 * read the fault list…" in the other. Typed: a phrase that does not start with a known verb is a
 * compile error, and `state-block-action.test.ts` holds every call site in the source to it.
 */
export const STATE_BLOCK_VERBS = {
  read: "Reading",
  load: "Loading",
  refresh: "Refreshing",
  open: "Opening",
  search: "Searching",
  "set up": "Setting up",
  download: "Downloading",
} as const;

export type StateBlockVerb = keyof typeof STATE_BLOCK_VERBS;
export type StateBlockAction = `${StateBlockVerb} ${string}`;

/** "read the fault list" → "Reading the fault list…". */
export function loadingSentence(action: StateBlockAction | undefined): string {
  if (!action) return "Reading…";
  const verb = (Object.keys(STATE_BLOCK_VERBS) as StateBlockVerb[])
    .sort((a, b) => b.length - a.length)
    .find((v) => action.startsWith(`${v} `));
  return verb ? `${STATE_BLOCK_VERBS[verb]} ${action.slice(verb.length + 1)}…` : "Reading…";
}
