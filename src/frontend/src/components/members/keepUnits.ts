/**
 * "4 h 33 min" with each number BOUND to its unit (R7 L7-1, J7-5): a figure that has to wrap
 * breaks between whole groups ("4 h 33 min" → "4 h" / "33 min"), never between a number and its
 * unit ("4 h 33" / "min" — the member header and the phone card both did that at 200 % text).
 */
export function keepUnits(figure: string): string {
  return figure.replace(/(\d) /g, "$1 ");
}
