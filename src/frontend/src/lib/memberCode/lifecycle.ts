import { ApiError, endpoints, NetworkError, type MemberCodeEnrolment, type MemberCodeStatus } from "../api";
import { assertKnownZone, STEP_MS } from "./clubDay";
import { fromBase64Url, importHmacKey } from "./hotp";
import { loadMemberCode, saveMemberCode, wipeMemberCode, type MemberCodeRecord } from "./keyStore";
import { isCanonicalRef } from "./token";
import { noteCodeAsked } from "../../routeChunks";

/**
 * Enrol, refresh, re-enrol — the phone's half of `docs/specs/member-code.md` §10.
 *
 * <ul>
 *   <li><b>No key on this phone</b> (first visit, another member's key, a wiped store):
 *   `POST /me/code/enrol`, import S non-extractable, store it, drop the bytes.</li>
 *   <li><b>A key</b>: `GET /me/code` — refresh the clock offset from `server_time_ms` against
 *   the request's local midpoint, and re-enrol if `generation` (or the REF) moved. A password
 *   change, a suspension, an admin reset or sign-out-everywhere each bump it server-side.</li>
 * </ul>
 *
 * <p>
 * <b>The secret is handled in exactly one function</b> ({@link enrol}) and never leaves it as
 * anything but a non-extractable key: not logged, not put in state, not returned, not stored as
 * text. The response object that carried it is not kept either.
 * </p>
 */

/** What a sync could not do, sorted by what the page does about it. */
export type SyncFailure =
  /** No answer from the club at all — the phone is offline, or the club's system is. */
  | { kind: "network" }
  /** The club has barred this member; the key is wiped. The server's reason code rides along. */
  | { kind: "barred"; code: string }
  /** This server has no member codes (a 404 — it predates them). */
  | { kind: "unavailable" }
  /** Anything else: a refusal we do not recognise, or an answer that is not a valid enrolment. */
  | { kind: "failed"; error: unknown };

export type SyncResult = { record: MemberCodeRecord } | { record: MemberCodeRecord | null; failure: SyncFailure };

const BARRING = new Set(["member_suspended", "member_not_active", "no_membership"]);

export class InvalidEnrolment extends Error {
  constructor(what: string) {
    super(`The club's member-code answer was not usable: ${what}.`);
    this.name = "InvalidEnrolment";
  }
}

function classify(e: unknown): SyncFailure {
  if (e instanceof NetworkError) return { kind: "network" };
  if (e instanceof ApiError) {
    if (e.status === 403 && e.code && BARRING.has(e.code)) return { kind: "barred", code: e.code };
    if (e.status === 404) return { kind: "unavailable" };
  }
  return { kind: "failed", error: e };
}

/** `server − local`, against the local midpoint of the request that carried the server's clock. */
export function measureOffset(serverTimeMs: number, sentAt: number, receivedAt: number): number {
  return Math.round(serverTimeMs - (sentAt + receivedAt) / 2);
}

function checkEnrolment(e: MemberCodeEnrolment): void {
  if (!e || typeof e !== "object") throw new InvalidEnrolment("no body");
  if (e.v !== 1) throw new InvalidEnrolment(`version ${String(e.v)}`);
  if (typeof e.ref !== "string" || !isCanonicalRef(e.ref)) throw new InvalidEnrolment("REF");
  if (!Number.isSafeInteger(e.generation) || e.generation < 1) throw new InvalidEnrolment("generation");
  if (e.step_seconds !== STEP_MS / 1000) throw new InvalidEnrolment("step");
  if (typeof e.server_time_ms !== "number" || !Number.isFinite(e.server_time_ms)) throw new InvalidEnrolment("server time");
  if (typeof e.tz !== "string") throw new InvalidEnrolment("zone");
  try { assertKnownZone(e.tz); } catch { throw new InvalidEnrolment("zone"); }
  if (typeof e.secret !== "string") throw new InvalidEnrolment("secret");
}

/** Imports S from the wire. The decoded bytes are zeroed whatever happens. */
async function importSecret(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try { raw = fromBase64Url(secret); } catch { throw new InvalidEnrolment("secret"); }
  try {
    if (raw.length !== 32) throw new InvalidEnrolment("secret");
    return await importHmacKey(raw);
  } finally {
    raw.fill(0);
  }
}

/** `POST /me/code/enrol` → a stored, non-extractable key. */
export async function enrol(userId: string): Promise<MemberCodeRecord> {
  const sentAt = Date.now();
  const asked = endpoints.meCodeEnrol();
  // X6-3 — the door page's one read is on its way: Bookings' code may start behind it now.
  noteCodeAsked();
  const e = await asked;
  const receivedAt = Date.now();
  checkEnrolment(e);
  const record: MemberCodeRecord = {
    key: await importSecret(e.secret),
    ref: e.ref,
    generation: e.generation,
    tz: e.tz,
    offsetMs: measureOffset(e.server_time_ms, sentAt, receivedAt),
    userId,
    enrolledAt: receivedAt,
  };
  await saveMemberCode(record);
  return record;
}

/** Does this status answer mean the key on the phone is no longer the member's current one? */
function moved(status: MemberCodeStatus, record: MemberCodeRecord): boolean {
  if (status.generation !== record.generation) return true;
  return typeof status.ref === "string" && status.ref !== record.ref;
}

/** A zone from a status answer, if it is one this phone can compute in; otherwise the old one. */
function zoneFrom(status: MemberCodeStatus, fallback: string): string {
  if (typeof status.tz !== "string") return fallback;
  try { assertKnownZone(status.tz); return status.tz; } catch { return fallback; }
}

/** `GET /me/code` for a phone that holds a key: a fresh offset, or a re-enrolment. */
async function refresh(record: MemberCodeRecord): Promise<MemberCodeRecord> {
  const sentAt = Date.now();
  const status = await endpoints.meCodeStatus();
  const receivedAt = Date.now();
  if (!status || typeof status.generation !== "number" || typeof status.server_time_ms !== "number") {
    throw new InvalidEnrolment("status");
  }
  if (moved(status, record)) {
    // The key on this phone is no longer the member's: every code it makes is refused, online
    // and — once the rosters carry the new day keys — offline. It goes BEFORE the re-enrolment,
    // so a re-enrolment that fails leaves the page saying it needs signal rather than showing a
    // code nothing will take.
    await wipeMemberCode();
    return enrol(record.userId);
  }
  const next: MemberCodeRecord = {
    ...record,
    tz: zoneFrom(status, record.tz),
    offsetMs: measureOffset(status.server_time_ms, sentAt, receivedAt),
  };
  await saveMemberCode(next);
  return next;
}

/**
 * The key this phone may show for `userId`, and never another member's.
 *
 * <p>
 * A record stored for a different member is wiped on sight rather than ignored: a club phone
 * is a shared device, and a key left behind is a code somebody else can still hold up.
 * </p>
 */
export async function loadFor(userId: string): Promise<MemberCodeRecord | null> {
  const stored = await loadMemberCode();
  if (stored && stored.userId !== userId) {
    await wipeMemberCode();
    return null;
  }
  return stored;
}

/**
 * One exchange with the club. Always resolves: a failure comes back beside whatever key the
 * phone still holds, because a phone with no signal and a good key has a perfectly good code.
 */
export async function syncMemberCode(userId: string, stored: MemberCodeRecord | null): Promise<SyncResult> {
  try {
    return { record: stored ? await refresh(stored) : await enrol(userId) };
  } catch (e) {
    const failure = classify(e);
    if (failure.kind === "barred") {
      // The club has said no. A key kept past that is a code shown to a member the club has
      // turned away — and the server has rotated the generation anyway (§10 Rotation).
      await wipeMemberCode();
      return { record: null, failure };
    }
    // What the phone holds NOW — not `stored`, which a moved generation has just wiped.
    return { record: await loadFor(userId), failure };
  }
}
