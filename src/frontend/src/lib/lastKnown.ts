import type { MemberDoor, MyQrCode } from "./api";

/**
 * The member code page's own last-known-good store.
 *
 * <p>
 * <b>Why this exists at all.</b> `public/sw.js`'s `mayCache()` returns false for anything
 * under `/api/` and for any request carrying an `authorization` header. Both guards are
 * correct — the second is what stopped one member's wallet being served to another — and
 * neither may be relaxed. The consequence is that a member who opens this page with no
 * signal gets the shell and nothing in it: no code, no door statement, no number to call.
 * "Three states for every read" then gives that member three different ways of saying
 * nothing, which is precisely the person this whole surface is designed around.
 * </p>
 *
 * <p>
 * <b>Two rules make it safe rather than dangerous.</b> The code's expiry is stored as an
 * ABSOLUTE instant, never as the lifetime the server expressed, so a stored code can
 * never be re-read as freshly minted and drawn as live. And the last door DECISION is
 * never stored: a refusal from an earlier visit, shown to somebody standing at a door
 * tonight because the network happens to be down, would be the page inventing an event.
 * </p>
 *
 * <p>
 * Every accessor is wrapped. Private browsing throws on write, a locked-down profile
 * throws on read, and an embedded webview may have no storage at all — none of which is a
 * reason for the page not to render.
 * </p>
 */

export const LAST_KNOWN_KEY = "crusaders.member-door.last-known";

/**
 * Bump to discard every stored record. A shape read field-by-field by code that assumes
 * a different one surfaces as a blank card rather than as an error anybody can act on.
 *
 * <p>
 * <b>2 — the door record grew five fields.</b> `GET /api/v1/me/door` gained
 * `membership_detail`, `is_club_admin`, `early_entry_minutes`, `roster_max_entries` and
 * `door_log_retention_days`, and every one of them is read for a SENTENCE. A v1 record
 * survives a `Partial` parse intact and then tells a member the club has their membership
 * as "not active" when it is suspended, or names a roster cap of `undefined` — which is
 * the exact failure this counter exists to prevent, arriving as plausible prose rather
 * than as a crash anybody would notice.
 * </p>
 *
 * <p>
 * <b>3 — WIRE-R2 §4, and one of its three changes is a reversal rather than an addition.</b>
 * `doors_shut` and `timezone` are new, and `early_entry_minutes` is now null under every
 * policy but `booking_window`. A v2 record read as a v3 would carry a real number where the
 * new shape means "there is no early-entry window in force", and `doors_shut` would arrive
 * undefined — which the shut sentence reads as "none", putting the page back to promising a
 * member that a shut door opens for them. That is the exact sentence the wire change exists
 * to stop, so the record that predates it is discarded rather than patched.
 * </p>
 */
export const LAST_KNOWN_VERSION = 3;

/** The half of a code the offline page renders. No token beyond the code itself. */
export type LastKnownQr = {
  code: string;
  kind: "booking" | "ident";
  /** ABSOLUTE. See the class comment — this is the field that makes the store honest. */
  expiresAt: string;
  courtNumber: number | null;
  startsAt: string | null;
  doors: boolean;
  doorOpensAt: string | null;
  doorClosesAt: string | null;
};

/** The standing door facts, with the decision deliberately absent. */
export type LastKnownDoor = Omit<MemberDoor, "last_decision">;

export type LastKnown = {
  qr: { savedAt: string; value: LastKnownQr } | null;
  door: { savedAt: string; value: LastKnownDoor } | null;
};

type StoredRecord = LastKnown & { version: number };

const EMPTY: LastKnown = { qr: null, door: null };

function storage(): Storage | null {
  try { return window.localStorage ?? null; } catch { return null; }
}

function readRecord(): StoredRecord {
  const store = storage();
  if (!store) return { ...EMPTY, version: LAST_KNOWN_VERSION };
  try {
    const raw = store.getItem(LAST_KNOWN_KEY);
    if (!raw) return { ...EMPTY, version: LAST_KNOWN_VERSION };
    const parsed = JSON.parse(raw) as Partial<StoredRecord>;
    if (parsed?.version !== LAST_KNOWN_VERSION) return { ...EMPTY, version: LAST_KNOWN_VERSION };
    return {
      version: LAST_KNOWN_VERSION,
      qr: parsed.qr ?? null,
      door: parsed.door ?? null,
    };
  } catch {
    // Unreadable, unparseable, or refused. All three mean "nothing stored".
    return { ...EMPTY, version: LAST_KNOWN_VERSION };
  }
}

function writeRecord(next: StoredRecord): void {
  const store = storage();
  if (!store) return;
  try { store.setItem(LAST_KNOWN_KEY, JSON.stringify(next)); } catch { /* private mode, or full */ }
}

/** What the page last managed to get, or two nulls. Never throws. */
export function readLastKnown(): LastKnown {
  const { qr, door } = readRecord();
  return { qr, door };
}

/**
 * Remembers a code, with its expiry resolved to a wall-clock instant.
 *
 * <p>
 * The three door fields are optional on the wire — an API that predates them sends none
 * — so they are normalised here rather than at the four places that read them back.
 * </p>
 */
export function rememberQr(qr: MyQrCode): void {
  const value: LastKnownQr = {
    code: qr.code,
    kind: qr.kind,
    expiresAt: new Date(Date.now() + qr.expires_in_seconds * 1000).toISOString(),
    courtNumber: qr.court_number ?? null,
    startsAt: qr.starts_at ?? null,
    doors: qr.doors === true,
    doorOpensAt: qr.door_opens_at ?? null,
    doorClosesAt: qr.door_closes_at ?? null,
  };
  const current = readRecord();
  writeRecord({ ...current, qr: { savedAt: new Date().toISOString(), value } });
}

/**
 * Remembers the standing door facts. The decision is dropped here, on purpose.
 *
 * <p>
 * Field by field rather than by spreading the response and deleting one key, so that a
 * field added to the wire cannot reach storage — and the offline page cannot start
 * rendering one — without somebody deciding it should. The compiler makes that decision
 * unavoidable: {@link LastKnownDoor} is derived from `MemberDoor`, so a new wire field
 * fails this assignment until it is named here.
 * </p>
 */
export function rememberDoor(door: MemberDoor): void {
  const value: LastKnownDoor = {
    doors: door.doors,
    // B4 / E-H1: without this a member reading the page with no signal is told what the club
    // was like before it shut its doors, in the present tense.
    //
    // R3-4: it is optional on the wire now, and it travels as whatever arrived — including
    // `undefined`. Defaulting it here to one of the three answers would put the invented
    // fact back, one layer down, where the page can no longer tell it was invented.
    doors_shut: door.doors_shut,
    /* WIRE-R3 §5. Names, so a cached answer can still say WHICH door is shut. */
    doors_shut_names: door.doors_shut_names,
    // O1: the club's zone travels with the facts, so a cached clock face is still the club's
    // day rather than reverting to the viewer's the moment the network goes.
    timezone: door.timezone,
    policy: door.policy,
    membership: door.membership,
    membership_detail: door.membership_detail,
    is_club_admin: door.is_club_admin,
    next_booking: door.next_booking,
    early_entry_minutes: door.early_entry_minutes,
    roster_max_entries: door.roster_max_entries,
    contact: door.contact,
    door_log_retention_days: door.door_log_retention_days,
  };
  const current = readRecord();
  writeRecord({ ...current, door: { savedAt: new Date().toISOString(), value } });
}

// --- the walk-up switch's own memory ----------------------------------------------

/**
 * Where the "walk up / pay for someone" choice lives between renders of this page.
 *
 * <p>
 * <b>`sessionStorage`, not the record above, and the difference is the point.</b> Which
 * code a member wants is a decision about the next few minutes — they are at the desk
 * paying for somebody, or starting on a free court — and it should survive a reload, a
 * trip to the schedule and back, and a phone that killed the tab while it was in a pocket.
 * It should NOT survive next week: a member who paid for a friend on Tuesday and opens
 * the page before their own booking on Saturday wants their booking code, and handing
 * them an ident code that every court but the desk refuses is the original defect with a
 * longer fuse. A session is exactly that window.
 * </p>
 *
 * <p>
 * It is also not part of {@link LAST_KNOWN_KEY}'s record, which is a cache of what the
 * SERVER last said. This is what the member last chose, it is versionless, and mixing the
 * two would mean a schema bump silently changing somebody's choice.
 * </p>
 */
export const WALK_UP_KEY = "crusaders.member-door.walk-up";

function sessionStore(): Storage | null {
  try { return window.sessionStorage ?? null; } catch { return null; }
}

/** What the member last chose, or false. Never throws — see the class comment above. */
export function readWalkUpChoice(): boolean {
  const store = sessionStore();
  if (!store) return false;
  try { return store.getItem(WALK_UP_KEY) === "1"; } catch { return false; }
}

/** Remembers the choice for the rest of this session. Silent when storage refuses. */
export function rememberWalkUpChoice(walkUp: boolean): void {
  const store = sessionStore();
  if (!store) return;
  try { store.setItem(WALK_UP_KEY, walkUp ? "1" : "0"); } catch { /* private mode, or full */ }
}

/** Drops the lot. Used on sign-out and by tests; never by a failed read. */
export function forgetLastKnown(): void {
  const store = storage();
  try { store?.removeItem(LAST_KNOWN_KEY); } catch { /* nothing to do about it */ }
  // The member's own choice of code goes with it. Leaving one member's walk-up switch on
  // for whoever signs in next on the same phone is a small thing that reads as a big one.
  try { sessionStore()?.removeItem(WALK_UP_KEY); } catch { /* nothing to do about it */ }
}

/**
 * Whole minutes since a record was saved.
 *
 * <p>
 * Clamped at zero at both ends: a clock dragged backwards must not report a record from
 * the future, and an unreadable stamp is nought minutes rather than NaN minutes — which
 * is what would otherwise reach a member as "NaN minutes ago".
 * </p>
 */
export function minutesSince(savedAt: string): number {
  const at = Date.parse(savedAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((Date.now() - at) / 60_000));
}
