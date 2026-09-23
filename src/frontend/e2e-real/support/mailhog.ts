/**
 * Reads the local mailbox: MailHog's JSON API, where the Development stack's SMTP lands.
 *
 * <p>
 * The API mails `multipart/alternative` with base64-encoded parts, so the raw body is
 * unreadable and a regex over it finds nothing. Every part is decoded before searching.
 * </p>
 */
export const MAILHOG_URL = process.env.MAILHOG_URL ?? "http://localhost:8025";

type MimePart = { Headers: Record<string, string[] | undefined>; Body: string };
type MailhogMessage = {
  ID: string;
  Content: { Headers: Record<string, string[] | undefined>; Body: string };
  MIME: { Parts: MimePart[] | null } | null;
};
type SearchResult = { total: number; items: MailhogMessage[] };

export type Mail = { id: string; subject: string; text: string };

function header(h: Record<string, string[] | undefined>, name: string): string {
  return (h[name]?.[0] ?? "").toLowerCase();
}

function decodeQuotedPrintable(s: string): string {
  const bytes = s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8");
}

function decodeBody(headers: Record<string, string[] | undefined>, body: string): string {
  const encoding = header(headers, "Content-Transfer-Encoding");
  if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

/** `=?utf-8?B?...?=` subjects, decoded; anything else passes through. */
function decodeSubject(raw: string): string {
  return raw.replace(/=\?utf-8\?B\?([^?]+)\?=/gi, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

function toMail(m: MailhogMessage): Mail {
  const parts = m.MIME?.Parts ?? [];
  const decoded = parts.length
    ? parts.map((p) => decodeBody(p.Headers, p.Body)).join("\n")
    : decodeBody(m.Content.Headers, m.Content.Body);
  return { id: m.ID, subject: decodeSubject(m.Content.Headers.Subject?.[0] ?? ""), text: decoded };
}

/** Every message addressed to `to`, newest first. */
export async function mailsTo(to: string): Promise<Mail[]> {
  const url = `${MAILHOG_URL}/api/v2/search?kind=to&query=${encodeURIComponent(to)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MailHog search failed: HTTP ${res.status} at ${url}`);
  const body = (await res.json()) as SearchResult;
  return body.items.map(toMail);
}

/**
 * Waits for a message to `to` whose decoded text matches `pattern`, and returns the match.
 * Polls rather than sleeps: the API sends after the response, on its own schedule.
 */
export async function waitForMailMatch(to: string, pattern: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const mails = await mailsTo(to);
    seen = mails.length;
    for (const mail of mails) {
      const match = mail.text.match(pattern);
      if (match) return match;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`No mail to ${to} matched ${pattern} within ${timeoutMs} ms (${seen} message(s) to that address). Is SMTP pointed at MailHog?`);
}

/**
 * Re-homes a link from the mail onto the stack under test. The API writes links with
 * `App:PublicBaseUrl`, which need not be the address this run is using (Vite on :4173, say).
 */
export function rehome(link: string, baseURL: string): string {
  const from = new URL(link);
  const to = new URL(baseURL);
  from.protocol = to.protocol;
  from.host = to.host;
  return from.toString();
}

const VERIFY_LINK = /https?:\/\/[^\s"'<>]+\/verify-email\/[^\s"'<>]+/;

/** The address-confirmation link sent at registration, re-homed onto `baseURL`. */
export async function verificationLink(to: string, baseURL: string): Promise<string> {
  const [link] = await waitForMailMatch(to, VERIFY_LINK);
  return rehome(link, baseURL);
}
