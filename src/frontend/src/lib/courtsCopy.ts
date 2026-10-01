import { unsureWords } from "./lostReplyCopy";

/**
 * The Courts page's words (`/admin/courts`). Tests query by these.
 *
 * <p>
 * Prices are in CREDITS, always, and the copy says so wherever a price is set: a court's slice
 * price is what a member is charged, in the unit of account, and it was once labelled "(R)" —
 * an admin priced courts in the wrong unit.
 * </p>
 */
export const COURTS_COPY = {
  title: "Courts",
  description: "The courts members can book, and what a slice on each costs. Prices are in credits — rand only ever"
    + " buys credits.",
  add: "Add court",
  edit: "Edit",
  editLabel: (name: string) => `Edit ${name}`,
  refresh: "Refresh courts",
  readAction: "read the courts",
  readCaveat: "That does not mean the club has none.",
  emptyTitle: "No courts yet",
  emptyHint: "Add the club’s courts so members can book them.",
  listLabel: "The club’s courts",
  count: (inUse: number, total: number) => `${inUse} in use · ${total} ${total === 1 ? "court" : "courts"}`,
  number: (n: number) => `Court number ${n}`,
  price: (credits: number) => `${formatCredits(credits)} cr a slice`,
  inUse: "In use",
  notInUse: "Not in use",

  addTitle: "Add a court",
  addDescription: "It can be booked the moment it is added, at the price you set here.",
  editTitle: (name: string) => `Edit ${name}`,
  editDescription: "Changes apply to bookings made from now on. Bookings already made keep the price they were charged.",
  nameLabel: "Name",
  nameDescription: "What members see on the booking grid.",
  nameRequired: "Give the court a name.",
  priceLabel: "Price per slice (credits)",
  priceDescription: "Credits, not rand. Members are charged this per slice; rand only ever buys credits.",
  priceInvalid: "The price has to be 0 or more, in whole cents.",
  activeLabel: "Members can book this court",
  activeOn: "In use — on the booking grid.",
  activeOff: "Not in use — members can’t book it. Nothing already booked on it is cancelled.",
  cancel: "Cancel",
  saveEdit: "Save court",
  saveNew: "Add court",
  saved: (name: string) => `${name} saved.`,
  added: (name: string) => `${name} added.`,
  saveAction: "save the court",
  addAction: "add the court",
  errorCodes: {
    name_required: "Give the court a name.",
    price_negative: "The price can't be below 0.",
  } as Record<string, string>,
} as const;

/**
 * @deprecated P13-F3: courts carry no price (contract §3.9, §7.1); deleted in phase 2.
 * `8` → `"8"`, `12.5` → `"12.50"` — credits to the cent, without a trailing `.00` on a whole number.
 */
export function formatCredits(credits: number): string {
  return Number.isInteger(credits) ? String(credits) : credits.toFixed(2);
}

/**
 * A court write whose reply was lost, read back from the courts list (review round 3, the admin
 * lost-reply audit): what the list still shows, and what cannot be told.
 */
export const COURTS_LOST = {
  add: (name: string) => unsureWords(`there is no ${name} yet`, `${name} was added`, "Courts"),
  save: (name: string) => unsureWords(`${name} still has its old details`, `${name} was saved`, "Courts"),
} as const;
