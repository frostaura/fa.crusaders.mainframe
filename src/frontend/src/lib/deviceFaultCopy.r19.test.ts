import { describe, expect, it } from "vitest";
import { explainFault, faultDetail } from "./deviceFaultCopy";

/**
 * R19 (BE19 D19-4 follow-through) — two `malformed_body` details the console had no words for.
 *
 * <ul>
 *   <li>`DeviceBody.TwoBoardsDetail` (R18 D18-5): a message that named more than one board was
 *   refused whole. The console showed the raw sentence, and its title said the server "could not
 *   read" a message it read perfectly well.</li>
 *   <li>Since D19-4 a body naming two boards is filed against NEITHER, on the club's folded row, with
 *   " (boards named: &lt;mac&gt;, &lt;mac&gt;)" after the detail — so a cut body naming two boards read as
 *   raw text and lost the "dropped" explanation.</li>
 * </ul>
 * The strings are the server's, verbatim: `DeviceBody.FileAsync`'s suffix and the constants.
 */
const TWO_BOARDS = "the message named more than one board, so nothing in it was used";
const NOT_JSON = "the message could not be read at all, so nothing in it was used";
const REPLACED = "some characters could not be read and were replaced; the rest was read and used";
const DROPPED_HEADLINE = "A board sent something the server could not read";
const named = (...macs: string[]) => ` (boards named: ${macs.join(", ")})`;
const BOX = "5ccf7f0a1b2c";
const GATE = "a4cf12bb0901";

const JARGON = /U\+FFFD|UTF-8|JSON|\bbody\b|malformed|boards named:/i;

describe("R19 — a message naming more than one board", () => {
  it.each([
    ["box then gate", `events: ${TWO_BOARDS}${named(BOX, GATE)}`],
    ["gate then box", `gate: ${TWO_BOARDS}${named(GATE, BOX)}`],
    ["no list (filed before D19-4)", `activate: ${TWO_BOARDS}`],
  ])("%s: its own title and words, not 'could not read'", (_n, detail) => {
    const said = explainFault({ code: "malformed_body", headline: DROPPED_HEADLINE, detail });
    expect(said.unrecognised).toBe(false);
    expect(said.title).toMatch(/more than one board/);
    expect(said.title).not.toMatch(/could not read/);
    expect(said.means).toMatch(/nothing in it was used/);
    expect(said.means).not.toMatch(/could not read/);
    expect(`${said.title} ${said.means} ${said.doThis}`).not.toMatch(JARGON);
  });

  it("the detail line names the route, says it was dropped, and lists every board it named", () => {
    const line = faultDetail(`events: ${TWO_BOARDS}${named(BOX, GATE)}`, undefined);
    expect(line).toMatch(/^What the board was sending: its upload of scans and switches — /);
    expect(line).toMatch(/named more than one board, so nothing in it was used/);
    expect(line).toContain(`${BOX} and ${GATE}`);
    expect(line).not.toMatch(JARGON);
  });

  it("a cut message naming two boards keeps the dropped explanation and lists both boards", () => {
    const detail = `pay-for: ${NOT_JSON}${named(GATE, BOX)}`;
    const said = explainFault({ code: "malformed_body", headline: DROPPED_HEADLINE, detail });
    expect(said.unrecognised).toBe(false);
    expect(said.means).toMatch(/could not read at all, so it was dropped/);
    const line = faultDetail(detail, undefined);
    expect(line).toMatch(/pay-for at the box — it could not be read at all, so nothing in it was used/);
    expect(line).toMatch(/filed against neither/);
    expect(line).toContain(`${GATE} and ${BOX}`);
    expect(line).not.toMatch(JARGON);
  });

  it("three boards are listed as a list", () => {
    expect(faultDetail(`events: ${NOT_JSON}${named(BOX, GATE, "0011223344ff")}`, undefined))
      .toContain(`${BOX}, ${GATE} and 0011223344ff`);
  });

  it("a read-anyway message that named two boards keeps its read-anyway words, whatever headline came with it", () => {
    const said = explainFault({ code: "malformed_body", headline: DROPPED_HEADLINE, detail: `events: ${REPLACED}${named(BOX, GATE)}` });
    expect(said.title).not.toMatch(/could not read/);
    expect(said.means).toMatch(/read the rest and acted on it/);
  });
});
