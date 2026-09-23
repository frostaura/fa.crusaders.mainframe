/**
 * A confirm sentence written for the old two-tap control — "Shut this door? It hears this at
 * once." — split into the dialog's question (its title) and its consequence (its description),
 * so the copy layer keeps ONE sentence per decision and the dialog does not ask twice.
 */
export function splitQuestion(sentence: string): { question: string | null; consequence: string } {
  const at = sentence.indexOf("? ");
  if (at < 0) return { question: null, consequence: sentence };
  return { question: sentence.slice(0, at + 1), consequence: sentence.slice(at + 2) };
}
