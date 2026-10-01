/**
 * The webhooks page's own words, where a test has to query them.
 */

/** What a create whose reply was lost says, per what reading the list again found (F3-11). */
export const LOST_CREATE = {
  created: "It was created — the reply got lost, so the list was read again and it is there. Its signing secret was in that reply and cannot be shown again: remove it and create it again to get one you can copy.",
  notCreated: "The reply got lost, so the list was read again: it isn't there, so nothing was created. Try again.",
  unknown: "The reply got lost and the list couldn't be read either, so it isn't known whether it was created. Refresh the list before trying again — a second one would send every event twice.",
} as const;

/**
 * An endpoint's name: its description, or — with none — where it sends (R5 A5-10: the card and its
 * menu read "(no description)", and "More actions for (no description)" names nothing).
 */
export function endpointName(endpoint: { description?: string | null; url_template: string }): string {
  const own = endpoint.description?.trim();
  if (own) return own;
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#{}]+)/i.exec(endpoint.url_template.trim())?.[1];
  return host ? `Endpoint to ${host.replace(/^[^@]*@/, "")}` : "Unnamed endpoint";
}
