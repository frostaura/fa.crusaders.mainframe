#!/usr/bin/env python3
"""Generates this directory's cases.json and manifest.json: what the court box's glass
says, composed on the Mega (court_mega 3.0.0) and previewed in the admin console.

Run it as `python3 src/contracts/device-protocol/display/gen_cases.py`. Standard library
only. This file is the REFERENCE implementation of three pure functions:

  * landing(...)        — the idle screen for either layout, from the Mega's own state;
  * marquee_window(...) — the visible window of a row wider than the glass;
  * screen_crc(...)     — the CRC a v3 `!CMT` commit carries over its staged rows.

The Mega's courtlogic (C++11, 8 KB of SRAM) implements them; the bridge renders the
CRC; the console's landing preview (TypeScript) renders `landing` from live control-board
data. Each is checked against this file's output, never against itself.

Contract: docs/specs/device-serial-protocol.md, sections "v3 — Screens" and "v3 — Landing".
"""
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent

WIDTH = {"compact": 16, "expanded": 20}
ROWS = {"compact": 2, "expanded": 4}
CTA = {"compact": "SCAN YOUR QR", "expanded": "SCAN YOUR QR CODE"}
OUT_OF_SERVICE = "OUT OF SERVICE"
GAP = "   "  # between marquee items, and between the end of a marquee and its restart
MAX_MINUTES_SHOWN = 999

STATUS_TEXT = {
    "starting": "STARTING UP",
    "no_wifi": "NO WIFI",
    "no_server": "NO SERVER",
    "offline": "SEE THE DESK",  # the bridge is dead: the Mega's own liveness verdict
}


def center(text: str, width: int) -> str:
    text = text[:width]
    left = (width - len(text)) // 2
    return (" " * left + text).ljust(width)


def minutes(seconds: int) -> int:
    """Whole minutes of light left, rounded UP: a court with 20 s left reads 1 MIN,
    never 0 MIN while its relay is closed."""
    return min(MAX_MINUTES_SHOWN, -(-seconds // 60))


def court_cell(number: int, lit: bool, seconds: int, layout: str) -> str:
    """One court on one row, left label and right state, justified to the width. The
    label shortens (COURT 12 -> CT 12) only when the two would not fit together."""
    width = WIDTH[layout]
    if lit:
        right = (f"ON {minutes(seconds)} MIN" if layout == "expanded" else f"{minutes(seconds)} MIN")
    else:
        right = "OFF"
    for label in (f"COURT {number}", f"CT {number}", f"{number}"):
        if len(label) + 1 + len(right) <= width:
            return label + " " * (width - len(label) - len(right)) + right
    return (f"{number} {right}")[:width].ljust(width)


def court_item(number: int, lit: bool, seconds: int) -> str:
    """A court as a marquee item: no padding, compact wording."""
    return f"COURT {number} {minutes(seconds)} MIN" if lit else f"COURT {number} OFF"


def status_item(status: str, clock, note) -> str:
    if status == "offline":
        return STATUS_TEXT["offline"]
    if note:
        return note
    if status == "ready":
        return f"READY {clock[:2]}:{clock[2:]}" if clock else "READY"
    return STATUS_TEXT[status]


def marquee_window(text: str, width: int, offset: int) -> str:
    """A row no wider than the glass is static. A wider one loops: the text, a gap,
    the text again — one character per step, offset counted from when the row was
    committed."""
    if len(text) <= width:
        return text.ljust(width)
    loop = text + GAP
    start = offset % len(loop)
    return (loop + loop)[start:start + width]


def landing(layout: str, marquee: bool, status: str, clock, note, courts, page: int, offset: int):
    """The idle glass. `courts` is the Mega's own view in relay order: each
    {"number": club court number from !MAP (0 = unmapped, never shown),
    "lit": relay closed, "seconds": seconds of light left}. A relay that is open
    reads OFF whatever any other source said; `seconds` is already the larger of the
    Mega's own deadline and the bridge's `!LAND` figure (chained paid extensions)."""
    width = WIDTH[layout]
    mapped = [c for c in courts if c["number"] > 0]
    title = OUT_OF_SERVICE if status == "offline" else CTA[layout]
    rows = [center(title, width)]
    status_line = status_item(status, clock, note)
    if layout == "expanded":
        items = [court_cell(c["number"], c["lit"], c["seconds"], layout) for c in mapped]
        items.append(status_line[:width].ljust(width))
        pages = -(-len(items) // 3)
        p = page % pages
        shown = items[3 * p:3 * p + 3]
        rows += shown + [" " * width] * (3 - len(shown))
        return rows
    if marquee:
        text = GAP.join([court_item(c["number"], c["lit"], c["seconds"]) for c in mapped] + [status_line])
        rows.append(marquee_window(text, width, offset))
        return rows
    items = [court_cell(c["number"], c["lit"], c["seconds"], layout) for c in mapped]
    items.append(status_line[:width].ljust(width))
    rows.append(items[page % len(items)])
    return rows


def crc16_ccitt_false(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def screen_crc(rows: dict) -> str:
    """CRC-16/CCITT-FALSE over, for each staged row in ascending row order: the row
    index as one byte, the row's staged text exactly as unescaped on the Mega, then
    one 0x00. Four uppercase hex digits on the wire."""
    data = bytearray()
    for r in sorted(rows):
        data.append(r)
        data += rows[r].encode("ascii")
        data.append(0)
    return format(crc16_ccitt_false(bytes(data)), "04X")


def main() -> int:
    assert crc16_ccitt_false(b"123456789") == 0x29B1  # the published check value
    four = [{"number": 1, "lit": True, "seconds": 2700}, {"number": 2, "lit": False, "seconds": 0},
            {"number": 3, "lit": True, "seconds": 20}, {"number": 4, "lit": False, "seconds": 0}]
    cases = {
        "description": ("The court box's glass: landing composition for the compact (16x2) and expanded (20x4) "
                        "layouts, the marquee window, and the v3 screen-commit CRC. Generated by gen_cases.py "
                        "beside this file. Contract: docs/specs/device-serial-protocol.md."),
        "constants": {"width": WIDTH, "rows": ROWS, "cta": CTA, "gap": GAP, "out_of_service": OUT_OF_SERVICE,
                      "max_minutes_shown": MAX_MINUTES_SHOWN, "status_text": STATUS_TEXT,
                      "crc": "CRC-16/CCITT-FALSE, check value 29B1"},
        "landing": [], "marquee": [], "screen_crc": [],
    }

    def lc(cid, note, layout, marquee, status, clock, note_text, courts, page=0, offset=0):
        cases["landing"].append({
            "id": cid, "note": note,
            "input": {"layout": layout, "marquee": marquee, "status": status, "clock": clock,
                      "note": note_text, "courts": courts, "page": page, "offset": offset},
            "rows": landing(layout, marquee, status, clock, note_text, courts, page, offset)})

    lc("land-x-four-courts-page0", "expanded, four mapped courts: one court per row, three per page", "expanded", True,
       "ready", "1805", None, four, 0)
    lc("land-x-four-courts-page1", "the second page carries the fourth court and the status", "expanded", True,
       "ready", "1805", None, four, 1)
    lc("land-x-page-wraps", "page counts from landing entry and wraps", "expanded", True, "ready", "1805", None, four, 2)
    lc("land-x-two-courts", "two courts and the status fit one page: no paging", "expanded", False, "ready", None, None,
       four[:2], 5)
    lc("land-x-unmapped-hidden", "an unmapped relay is never shown as a dark court", "expanded", True, "no_server", "2010", None,
       [{"number": 1, "lit": True, "seconds": 61}, {"number": 0, "lit": False, "seconds": 0},
        {"number": 0, "lit": False, "seconds": 0}, {"number": 0, "lit": False, "seconds": 0}])
    lc("land-x-no-map-yet", "before the first !MAP: the call to action and the status only", "expanded", True, "starting",
       None, None, [{"number": 0, "lit": False, "seconds": 0}] * 4)
    lc("land-x-offline", "the bridge is dead (no frame for 3 x !LIVE period): the call to action is withdrawn, the "
       "lit courts still show the Mega's own minutes", "expanded", True, "offline", "1805", "SETUP MODE", four, 0)
    lc("land-x-chained-minutes", "a chained paid extension past the 90-minute cap shows the whole paid remainder",
       "expanded", True, "ready", "1805", None, [{"number": 2, "lit": True, "seconds": 7140}], 0)
    lc("land-x-wide-court-number", "a four-digit court label shortens to CT before the state is cut", "expanded", True,
       "ready", "1805", None, [{"number": 1234, "lit": True, "seconds": 59400}], 0)
    lc("land-x-note", "a bridge !NOTE replaces the status item (here: the setup portal is open)", "expanded", True,
       "ready", "1805", "SETUP AP 1A2B", four[:1], 0)
    lc("land-c-marquee-offset0", "compact with the marquee: every court and the status on row 1", "compact", True, "ready",
       "1805", None, four, 0, 0)
    lc("land-c-marquee-offset7", "seven steps on", "compact", True, "ready", "1805", None, four, 0, 7)
    lc("land-c-marquee-wrap", "the loop restarts after the text and one gap", "compact", True, "ready", "1805", None, four,
       0, len(GAP.join([court_item(**c) for c in four] + ["READY 18:05"])) + len(GAP))
    lc("land-c-marquee-fits-static", "a summary that fits sixteen columns does not scroll", "compact", True, "ready", None,
       None, [{"number": 0, "lit": False, "seconds": 0}] * 4, 0, 9)
    lc("land-c-pages-page0", "compact with the marquee off: one court per page", "compact", False, "ready", "1805", None,
       four, 0)
    lc("land-c-pages-page2", "", "compact", False, "ready", "1805", None, four, 2)
    lc("land-c-pages-status", "the last page is the status", "compact", False, "no_wifi", "1805", None, four, 4)
    lc("land-c-offline", "compact, bridge dead", "compact", False, "offline", None, None, four, 1)
    lc("land-c-minute-rounding", "20 seconds of light reads 1 MIN, 60 reads 1, 61 reads 2", "compact", False, "ready",
       None, None, [{"number": 1, "lit": True, "seconds": 20}, {"number": 2, "lit": True, "seconds": 60},
                    {"number": 3, "lit": True, "seconds": 61}], 1)

    def mq(cid, note, text, width, offset):
        cases["marquee"].append({"id": cid, "note": note, "text": text, "width": width, "offset": offset,
                                 "window": marquee_window(text, width, offset)})

    long_text = "ENJOY YOUR GAME, SEE YOU NEXT TIME"
    mq("mq-fits", "no scroll when it fits", "COURT 3 45 MIN", 16, 12)
    mq("mq-exact", "exactly the width: still static", "SCAN YOUR QR COD", 16, 3)
    mq("mq-start", "", long_text, 16, 0)
    mq("mq-mid", "", long_text, 16, 10)
    mq("mq-into-gap", "the gap appears before the restart", long_text, 16, len(long_text) - 4)
    mq("mq-wrap", "offset equal to text + gap is offset 0 again", long_text, 16, len(long_text) + len(GAP))
    mq("mq-expanded", "the expanded width", long_text, 20, 5)
    mq("mq-48", "the longest row v3 can stage (two 24-character segments)", "A" * 24 + "B" * 24, 20, 30)

    def sc(cid, note, rows):
        cases["screen_crc"].append({"id": cid, "note": note,
                                    "rows": {str(k): v for k, v in sorted(rows.items())},
                                    "mask": sum(1 << r for r in rows), "crc": screen_crc(rows)})

    sc("crc-four-rows", "a full expanded verdict", {0: "COURT 3", 1: "ON 45 MIN", 2: "ENDS 19:45", 3: "ENJOY YOUR GAME"})
    sc("crc-two-rows", "a compact screen stages rows 0 and 1 only", {0: "HI DEAN", 1: "BALANCE 120 MIN"})
    sc("crc-empty-row", "an empty row is still a staged row: mask bit set, index and terminator in the CRC",
       {0: "ONE MOMENT", 1: ""})
    sc("crc-row-order-matters", "the same texts on swapped rows give a different CRC",
       {0: "BALANCE 120 MIN", 1: "HI DEAN"})
    sc("crc-escaped-chars", "the CRC is over UNESCAPED text: ',' '%' '!' as characters, not as %2C %25 %21",
       {0: "SMITH, J", 1: "50% OFF!"})
    sc("crc-48-char-row", "a two-segment row", {2: "A" * 24 + "B" * 24})

    (HERE / "cases.json").write_text(json.dumps(cases, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    manifest = {
        "description": "Court-box glass: landing composition (compact and expanded), the marquee window, and the screen-commit CRC.",
        "authority": "docs/specs/device-serial-protocol.md; gen_cases.py beside this file is the reference implementation.",
        "generator": "src/contracts/device-protocol/display/gen_cases.py",
        "read_by": ["fw-court-box", "vitest"],
        "case_count": {k: len(v) for k, v in cases.items() if isinstance(v, list)},
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
