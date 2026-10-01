/** "A", "A and B", "A, B and C". */
function listed(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The Settings page's own words (plan R13). Tests query by these, so a copy change is one edit.
 *
 * <p>
 * The setting captions and their guidance are not here — they live in `settingsSchema.ts` beside
 * the bound each one describes. This is the page's chrome: the header, the search, the save bar,
 * the leave guard and the first-visit note.
 * </p>
 */
export const SETTINGS_COPY = {
  title: "Settings",
  eyebrow: "Admin · Setup",
  // "Tenant" is our word for a row in our database. An admin here is a club volunteer (A9).
  description: "Court schedule, booking limits, penalty policy and court-box behaviour for this club.",

  searchLabel: "Search settings",
  // Short enough to fit a 390px phone beside "Open all" (VIS F3-15 — it clipped to "— tr"); the
  // example it carried is said under the field instead.
  searchPlaceholder: "Search settings",
  searchHint: "Try “peak” or “door” — a setting's name or what it does.",
  clearSearch: "Clear search",
  expandAll: "Open all",
  collapseAll: "Close all",
  noMatches: (query: string) => `No setting matches “${query}”.`,
  noMatchesHint: "Try a shorter word, or what the setting does rather than its name.",
  matchCount: (n: number) => (n === 1 ? "1 setting matches" : `${n} settings match`),

  unsaved: "Unsaved changes",
  /** R4 form factor: the sections, listed beside them where the page has the room. */
  indexLabel: "Settings sections",
  indexGo: (title: string, unsaved: boolean) => `Go to ${title}${unsaved ? " (unsaved changes)" : ""}`,
  advancedShow: (n: number) => (n === 1 ? "Show 1 advanced setting" : `Show ${n} advanced settings`),
  advancedHide: "Hide advanced settings",
  notServed: "The club’s system is not serving these settings yet, so there is nothing to change here.",
  // P13: the money section points at the two pages that hold what it no longer does.
  packagesLink: "Set the club's packages on Packages",
  groupDiscountsLink: "Set a group's package discount on Groups",
  groupsLink: "Member groups can lower these for their own members",

  changes: (n: number) => (n === 1 ? "1 unsaved change" : `${n} unsaved changes`),
  savedHint: "Nothing is saved until you press Save changes.",
  cannotSave: "Can’t save yet",
  blockers: (n: number) => `${n} ${n === 1 ? "setting needs" : "settings need"} fixing before this can be saved:`,
  save: "Save changes",
  discard: "Discard",
  saved: "Settings saved.",
  saveFailed: "Save failed.",
  /** F3.15: the save banner — what went wrong, and what to do next. */
  saveNotSaved: "Nothing was saved. Your changes are still here — fix what is named and press Save again.",
  saveRefusedUnnamed: "The club’s system refused these settings without naming the field. Nothing was saved — check the fields you changed, or discard and start again.",
  saveGoTo: (label: string) => `Go to ${label}`,
  /** The banner when the refusal names a field: the reason itself is said AT the field. */
  saveRefusedField: (label: string) => `The club’s system refused ${label}. The reason is on the field.`,
  draftRestored: "Your unsaved changes were kept while you signed in again. They are not saved yet.",
  /** R3 A-9: kept across a reload or a visit elsewhere — no sign-in happened, so none is claimed. */
  draftRestoredEarlier: "Your unsaved changes from earlier were kept. They are not saved yet.",
  /** R3 A-12: the club's rate limit — busy, nothing saved, nothing to fix. */
  saveRateLimited: (busy: string) => `${busy} Nothing was saved; your changes are still here.`,
  /** F3-4: kept edits to a setting somebody else has saved since are not restored over theirs. */
  draftDropped: (labels: string[]) =>
    `${labels.join(", ")} ${labels.length === 1 ? "was" : "were"} saved by someone else while you were away, so your change${labels.length === 1 ? "" : "s"} there ${labels.length === 1 ? "was" : "were"} not brought back.`,
  /** F3-4: a lost reply, and the club read again to find out. */
  saveDidNotArrive: "That save didn't reach the club — the settings were read again and nothing changed. Your changes are still here; press Save again.",
  saveUnknown: "It isn't known yet whether that saved: the reply got lost and the club couldn't be asked. Your changes are still here — saving again is safe: if the first one landed, the page will say so.",
  /** A4-1: a save refused because somebody else saved since this page was read. */
  conflictTitle: "Someone else saved Settings while you had this page open. Nothing of yours was saved.",
  conflictTheirs: (labels: string[]) =>
    `They changed ${listed(labels)}. The page now shows their ${labels.length === 1 ? "value" : "values"}.`,
  conflictKept: (n: number) =>
    `Your ${n === 1 ? "other change is" : `${n} other changes are`} still here on top of theirs, not saved yet — check, then press Save.`,
  conflictClashed: (labels: string[]) =>
    `You both changed ${listed(labels)}: theirs is showing now.`,
  conflictReapply: (n: number) => (n === 1 ? "Put my value back" : "Put my values back"),
  conflictDismiss: "Keep theirs",
  savedAfterLostReply: "Settings saved. The reply got lost, so the club was asked — your changes are on it.",
  dismissSaved: "Dismiss",
  movedTo: (label: string) => `Settings cannot be saved yet. Moved to ${label}.`,
  saveBarLabel: "Unsaved settings",

  discardTitle: "Discard your changes?",
  discardBody: (n: number) => `${n === 1 ? "The change" : `All ${n} changes`} you made since the last save will be`
    + " undone. Nothing on the club’s system changes.",
  discardConfirm: "Discard changes",
  keepEditing: "Keep editing",

  leaveTitle: "Leave without saving?",
  leaveBody: (n: number) => `You have ${n === 1 ? "1 unsaved change" : `${n} unsaved changes`} on Settings. Leaving`
    + " throws them away.",
  leaveConfirm: "Leave without saving",

  readAction: "read the club’s settings",
  readCaveat: "Nothing was changed.",

  introTitle: "How Settings works",
  introBody: [
    "Settings are grouped into sections — each shows its current setup in one line. Open one to change it.",
    "Search finds any setting by name or by what it does.",
    "Press (i) beside a setting for the full story: what it reaches and what changing it costs.",
    "Nothing is saved until you press Save changes, and you can discard everything before then.",
  ],
  introDismiss: "Got it",

  ownHours: "Own hours",
  ownHoursLabel: (day: string) => `${day} has its own hours`,
  opens: (day: string) => `${day} opens`,
  closes: (day: string) => `${day} closes`,
  dayDefault: (open: string, close: string) => `Club default — ${open} to ${close}`,
  dayHoursLabel: (day: string) => `${day} opening hours`,
  peakStarts: "Peak starts",
  peakEnds: "Peak ends",
  switchOn: "On — every look is recorded",
  switchOff: "Off — the page is not there",
} as const;

/** The localStorage key for the first-visit note (a per-viewer convenience, never state). */
export const SETTINGS_INTRO_KEY = "crusaders:settings-intro-dismissed";
