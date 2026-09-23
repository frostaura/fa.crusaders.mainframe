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
  searchPlaceholder: "Search settings — try “peak” or “door”",
  clearSearch: "Clear search",
  expandAll: "Open all",
  collapseAll: "Close all",
  noMatches: (query: string) => `No setting matches “${query}”.`,
  noMatchesHint: "Try a shorter word, or what the setting does rather than its name.",
  matchCount: (n: number) => (n === 1 ? "1 setting matches" : `${n} settings match`),

  unsaved: "Unsaved changes",
  advancedShow: (n: number) => (n === 1 ? "Show 1 advanced setting" : `Show ${n} advanced settings`),
  advancedHide: "Hide advanced settings",
  notServed: "The club’s system is not serving these settings yet, so there is nothing to change here.",
  movingToGroups: "Moving to Groups",
  movingToGroupsNote: "Member-class rates are moving to Groups, where each group will carry its own rate. They keep"
    + " working here until then.",
  groupsLink: "Member groups can lower these for their own members",

  changes: (n: number) => (n === 1 ? "1 unsaved change" : `${n} unsaved changes`),
  savedHint: "Nothing is saved until you press Save changes.",
  cannotSave: "Can’t save yet",
  blockers: (n: number) => `${n} ${n === 1 ? "setting needs" : "settings need"} fixing before this can be saved:`,
  save: "Save changes",
  discard: "Discard",
  saved: "Settings saved.",
  saveFailed: "Save failed.",
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
