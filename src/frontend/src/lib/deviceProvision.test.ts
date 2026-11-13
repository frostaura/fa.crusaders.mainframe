import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL_MAX, checkBaseUrl, isDeviceKey, pskProblem, ssidProblem } from "./deviceProvision";

/**
 * The console's network and key checks against the `provision/` corpus, so the form refuses what a
 * board would refuse — in the board's own terms. Every `base_urls` vector is executed; the `keys`
 * vectors are read for their key grammar.
 */

const CORPUS = resolve(__dirname, "../../../contracts/device-protocol/provision");
const cases = JSON.parse(readFileSync(join(CORPUS, "cases.json"), "utf8")) as {
  constants: { base_url_max: number };
  base_urls: { id: string; url: string; accept: boolean; reason: string }[];
  keys: { id: string; key_next: { id?: unknown; key?: unknown }; reason: string }[];
  nets: { id: string; net: Record<string, unknown>; reason: string }[];
};
let ran = 0;

describe("provision corpus — base_urls", () => {
  it.each(cases.base_urls.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(checkBaseUrl(c.url)).toBe(c.reason);
    expect(checkBaseUrl(c.url) === "ok").toBe(c.accept);
    ran += 1;
  });
});

describe("provision corpus — the key grammar", () => {
  it("accepts exactly the keys the corpus does not refuse as `key`", () => {
    for (const c of cases.keys) {
      if (typeof c.key_next.key !== "string") continue;
      expect(isDeviceKey(c.key_next.key), c.id).toBe(c.reason !== "key");
    }
  });
});

describe("provision corpus — the WiFi fields", () => {
  it("refuses the SSIDs and passwords the corpus refuses", () => {
    for (const c of cases.nets) {
      for (const slot of [0, 1]) {
        const ssid = c.net[`wifi${slot}_ssid`];
        const psk = c.net[`wifi${slot}_psk`];
        if (c.reason === `wifi${slot}_ssid` && typeof ssid === "string") expect(ssidProblem(ssid), c.id).not.toBeNull();
        if (c.reason === `wifi${slot}_psk` && typeof psk === "string") expect(pskProblem(psk), c.id).not.toBeNull();
        if (c.reason === "ok" && typeof ssid === "string") expect(ssidProblem(ssid), c.id).toBeNull();
        if (c.reason === "ok" && typeof psk === "string") expect(pskProblem(psk), c.id).toBeNull();
      }
    }
    expect(pskProblem("")).toBeNull(); // an open network
    expect(pskProblem("short")).not.toBeNull();
    expect(ssidProblem("")).not.toBeNull();
  });

  it("holds the corpus's own length bound", () => {
    expect(cases.constants.base_url_max).toBe(BASE_URL_MAX);
  });
});

afterAll(() => {
  expect(ran).toBe(cases.base_urls.length);
  expect(cases.base_urls.length).toBeGreaterThanOrEqual(18);
});
