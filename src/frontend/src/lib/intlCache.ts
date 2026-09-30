/**
 * One `Intl.DateTimeFormat` per (locale, options), built once and reused.
 *
 * <p>
 * Building a formatter is the expensive part of formatting — it resolves the locale and loads the
 * zone's rules — and the booking grid asked for a fresh one per cell and per render: ~35 ms of
 * each tap at 4x CPU went to constructing formatters for answers that never change (perf lane,
 * 2026-09-30). A formatter is immutable, so sharing one changes nothing about its output.
 * </p>
 *
 * <p>
 * Construction still throws `RangeError` for a zone this engine does not know, exactly as before,
 * and a formatter that threw is never cached. <b>A formatter with no `timeZone` is never cached
 * either</b>: it captures the device's zone when built, and "the reader's own clock" must follow
 * a device that changes zone (and the tests that move it).
 * </p>
 */
const cache = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  if (options.timeZone === undefined) return new Intl.DateTimeFormat(locale, options);
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    cache.set(key, formatter);
  }
  return formatter;
}
