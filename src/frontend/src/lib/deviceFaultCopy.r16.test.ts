import { describe, expect, it } from "vitest";
import { explainFault, faultDetail } from "./deviceFaultCopy";

/**
 * R16 D16-5 — a `malformed_body` fault says which of its two kinds it is, in plain words.
 *
 * <p>
 * The server files the code for two different things (`DeviceBody`): a body with invalid UTF-8,
 * which it reads leniently (each bad sequence becomes U+FFFD) and ACTS ON; and a body that is not
 * JSON at all, which it drops. The page said "could not read at all" for both, and showed the
 * server's detail raw — "activate: invalid UTF-8 read as U+FFFD", "pay-for: body is not JSON",
 * "unknown: malformed" — to a volunteer holding a phone.
 * </p>
 */

const HEADLINE = "A board sent something the server could not read";
const JARGON = /U\+FFFD|UTF-8|JSON|\bbody\b|malformed|unknown:/i;

describe("R16 D16-5 — the two kinds of unreadable message", () => {
  it.each(["activate", "events", "pay-for"])("garbled characters, read anyway (%s): never 'could not read at all'", (route) => {
    const said = explainFault({ code: "malformed_body", headline: HEADLINE, detail: `${route}: invalid UTF-8 read as U+FFFD` });
    expect(said.means).not.toMatch(/could not read at all/);
    expect(said.title).not.toMatch(/could not read/);
    expect(said.means).toMatch(/garbled/);
    expect(`${said.title} ${said.means} ${said.doThis}`).not.toMatch(JARGON);
  });

  it.each(["pay-for: body is not JSON", "walkup: body is not JSON", "unknown: malformed", "events: body too large", null])(
    "unreadable (%s): says it was dropped, and keeps the server's headline", (detail) => {
      const said = explainFault({ code: "malformed_body", headline: HEADLINE, detail });
      expect(said.title).toBe(HEADLINE);
      expect(said.means).toMatch(/could not read/);
      expect(`${said.means} ${said.doThis}`).not.toMatch(JARGON);
    },
  );

  it.each([
    ["activate: invalid UTF-8 read as U+FFFD", /scan asking for the lights/, /garbled/],
    ["pay-for: body is not JSON", /pay-for/, /could not be read at all/],
    ["walkup: body is not JSON", /walk-up/, /could not be read at all/],
    ["events: body too large", /upload of scans and switches/, /too large/],
    ["unknown: malformed", /message/, /could not be read/],
  ])("the detail line %s is in words", (detail, what, how) => {
    const line = faultDetail(detail, "Africa/Johannesburg");
    expect(line).toMatch(what);
    expect(line).toMatch(how);
    expect(line).not.toMatch(JARGON);
  });

  it("leaves every other detail as it was", () => {
    expect(faultDetail("served 2 relay(s), the box reported 0", undefined)).toBe("The club's system expected 2 courts to be lit; the box reported none.");
    expect(faultDetail("last seen mac AA:BB", undefined)).toBe("last seen mac AA:BB");
  });
});
