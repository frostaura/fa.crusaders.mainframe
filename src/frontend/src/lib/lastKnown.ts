import type { MemberDoor } from "./api";

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
 * <b>The last door DECISION is never stored</b>: a refusal from an earlier visit, shown to
 * somebody standing at a door tonight because the network happens to be down, would be the
 * page inventing an event.
 * </p>
 *
 * <p>
 * <b>No code is stored here any more (D1).</b> The member's code is made on the phone from a
 * non-extractable key held in IndexedDB (`lib/memberCode/keyStore.ts`) — never in
 * `localStorage`, which can only hold a secret as readable text. This store keeps the door
 * facts only.
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
 *
 * <p>
 * <b>4 — D1: the code half is gone.</b> A v3 record carries the last legacy booking or ident
 * code the page fetched; bumping discards it rather than leaving a code nothing renders sitting
 * in `localStorage`.
 * </p>
 */
export const LAST_KNOWN_VERSION = 4;

/** The standing door facts, with the decision deliberately absent. */
export type LastKnownDoor = Omit<MemberDoor, "last_decision">;

export type LastKnown = {
  door: { savedAt: string; value: LastKnownDoor } | null;
};

type StoredRecord = LastKnown & { version: number };

const EMPTY: LastKnown = { door: null };

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

/** What the page last managed to get, or null. Never throws. */
export function readLastKnown(): LastKnown {
  const { door } = readRecord();
  return { door };
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

/** Drops the lot. Used on sign-out and by tests; never by a failed read. */
export function forgetLastKnown(): void {
  const store = storage();
  try { store?.removeItem(LAST_KNOWN_KEY); } catch { /* nothing to do about it */ }
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
