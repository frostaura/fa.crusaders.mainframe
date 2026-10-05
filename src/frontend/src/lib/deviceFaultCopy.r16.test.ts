import { describe, expect, it } from "vitest";
import { explainFault, faultDetail } from "./deviceFaultCopy";

/**
 * R16 D16-5 — a `malformed_body` fault says which of its kinds it is, in plain words.
 *
 * <p>
 * The server files the code for three different things (`DeviceBody`, `DeviceEndpoints`): a body
 * with characters it could not read, which it reads leniently and ACTS ON; a heartbeat whose version
 * is too long to keep, whose rest it also uses; and a body it could not read at all, which it drops.
 * Since BE16a (d151a964) the server's details are plain words and its headline follows the detail
 * (`DeviceErrorCodes.HeadlineOf(code, detail)`), so the server's headline is the title for all three.
 * The strings below are the server's constants, copied verbatim — a server rewording fails here.
 * </p>
 */

/** `DeviceBody.ReplacedDetail`. */
const REPLACED = "some characters could not be read and were replaced; the rest was read and used";
/** `DeviceBody.NotJsonDetail`. */
const NOT_JSON = "the message could not be read at all, so nothing in it was used";
/** `DeviceEndpoints.VersionTooLongDetail`. */
const VERSION = "it reported a version longer than 32 characters, which was not kept";

/** `DeviceErrorCodes.HeadlineOf(code)` and the two variant headlines of `HeadlineOf(code, detail)`. */
const DROPPED_HEADLINE = "A board sent something the server could not read";
const READ_ANYWAY_HEADLINE = "A board sent a message with a few unreadable characters, and the rest was used";
const VERSION_HEADLINE = "A board reported a version too long to keep, and the rest of its check-in was used";

const JARGON = /U\+FFFD|UTF-8|JSON|\bbody\b|malformed|unknown:/i;

describe("R16 D16-5 — the kinds of unreadable message, in the server's words", () => {
  it.each(["activate", "events", "pay-for", "heartbeat"])("characters replaced, rest used (%s): the server's headline, never 'could not read at all'", (route) => {
    const said = explainFault({ code: "malformed_body", headline: READ_ANYWAY_HEADLINE, detail: `${route}: ${REPLACED}` });
    expect(said.title).toBe(READ_ANYWAY_HEADLINE);
    expect(said.means).not.toMatch(/could not read (it )?at all/);
    expect(said.means).toMatch(/read the rest/);
    expect(`${said.means} ${said.doThis}`).not.toMatch(JARGON);
  });

  it("a version too long to keep: the server's headline, and the means says the old version stays", () => {
    const said = explainFault({ code: "malformed_body", headline: VERSION_HEADLINE, detail: `heartbeat: ${VERSION}` });
    expect(said.title).toBe(VERSION_HEADLINE);
    expect(said.means).toMatch(/version/);
    expect(said.means).toMatch(/kept the one it had/);
    expect(said.means).not.toMatch(/could not read/);
    expect(`${said.means} ${said.doThis}`).not.toMatch(JARGON);
  });

  it.each([`pay-for: ${NOT_JSON}`, `walkup: ${NOT_JSON}`, "events: body too large", null])(
    "unreadable (%s): says it was dropped, and keeps the server's headline", (detail) => {
      const said = explainFault({ code: "malformed_body", headline: DROPPED_HEADLINE, detail });
      expect(said.title).toBe(DROPPED_HEADLINE);
      expect(said.means).toMatch(/could not read/);
      expect(`${said.means} ${said.doThis}`).not.toMatch(JARGON);
    },
  );

  it.each([
    [`activate: ${REPLACED}`, /scan asking for the lights/, /could not be read and were replaced; the rest was read/],
    [`heartbeat: ${VERSION}`, /regular check-in/, /version too long to keep/],
    [`pay-for: ${NOT_JSON}`, /pay-for/, /could not be read at all/],
    [`walkup: ${NOT_JSON}`, /walk-up/, /could not be read at all/],
    ["events: body too large", /upload of scans and switches/, /too large/],
  ])("the detail line %s is in words", (detail, what, how) => {
    const line = faultDetail(detail, "Africa/Johannesburg");
    expect(line).toMatch(what);
    expect(line).toMatch(how);
    expect(line).not.toMatch(JARGON);
  });

  it("a row with no headline still gets a title that matches what happened", () => {
    expect(explainFault({ code: "malformed_body", headline: null, detail: `events: ${REPLACED}` }).title).not.toMatch(/could not read|malformed/);
    expect(explainFault({ code: "malformed_body", headline: null, detail: `heartbeat: ${VERSION}` }).title).toMatch(/version/);
  });

  // Rows filed before d151a964 carry the old details; the server's headline for them is the dropped
  // one, which is false for the replaced kind. They still read true and without jargon.
  it.each([
    ["activate: invalid UTF-8 read as U+FFFD", /read the rest/, /scan asking for the lights/],
    ["pay-for: body is not JSON", /could not read/, /could not be read at all/],
    ["unknown: malformed", /could not read/, /could not be read/],
  ])("a row filed before the server's plain words (%s) still reads true", (detail, means, line) => {
    const said = explainFault({ code: "malformed_body", headline: DROPPED_HEADLINE, detail });
    expect(said.means).toMatch(means);
    expect(said.title).not.toMatch(JARGON);
    if (/U\+FFFD/.test(detail)) expect(said.title).not.toMatch(/could not read/);
    expect(faultDetail(detail, undefined)).toMatch(line);
    expect(faultDetail(detail, undefined)).not.toMatch(JARGON);
  });

  it("leaves every other detail as it was", () => {
    expect(faultDetail("served 2 relay(s), the box reported 0", undefined)).toBe("The club's system expected 2 courts to be lit; the box reported none.");
    expect(faultDetail("last seen mac AA:BB", undefined)).toBe("last seen mac AA:BB");
  });
});
