import { unsureWords } from "./lostReplyCopy";

/**
 * The Courts page's words (`/admin/courts`). Tests query by these.
 *
 * <p>
 * <b>A court has no price</b> (P13, contract §3.9): a booking costs its own playing minutes, so a
 * court is a name, a type and whether it is in use — nothing here may talk about what it costs.
 * </p>
 */
export const COURTS_COPY = {
  title: "Courts",
  description: "The courts members can book, and whether each is in use. A booking costs the minutes it is played for, on any court.",
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
  inUse: "In use",
  notInUse: "Not in use",

  addTitle: "Add a court",
  addDescription: "Members can book it the moment it is added.",
  editTitle: (name: string) => `Edit ${name}`,
  editDescription: "Changes apply from now on. Bookings already made on it stay as they are.",
  nameLabel: "Name",
  nameDescription: "What members see on the booking grid.",
  nameRequired: "Give the court a name.",
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
  } as Record<string, string>,
} as const;

/**
 * A court write whose reply was lost, read back from the courts list (review round 3, the admin
 * lost-reply audit): what the list still shows, and what cannot be told.
 */
export const COURTS_LOST = {
  add: (name: string) => unsureWords(`there is no ${name} yet`, `${name} was added`, "Courts"),
  save: (name: string) => unsureWords(`${name} still has its old details`, `${name} was saved`, "Courts"),
} as const;
