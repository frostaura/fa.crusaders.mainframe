/**
 * Badges and buttons in a table cell stay on one line (Dean, 2026-10-06: "Non-league / members"
 * split over two lines in a pill, a "Cancel" button doubling its height). A table scrolls sideways
 * in its own frame, so a row that needs the width takes it there rather than folding a pill or a
 * button in two. On the `<table>` of `ui/table`, `DataTable` and `LedgerTable` alike.
 */
export const TABLE_KEEP_WHOLE = "[&_[data-slot=badge]]:whitespace-nowrap [&_[data-slot=button]]:whitespace-nowrap";
