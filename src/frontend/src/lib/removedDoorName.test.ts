import { describe, expect, it } from "vitest";
import { GATE_PLACEHOLDER_NAME, removedDoorName } from "./doorsCopy";

/**
 * R13 L13-1 — the door log's "Removed doors" group named a deleted gate nobody had named by its
 * bare device id ("4c1f…-…"), where the export (R12 D12-3, `TraceKinds.DoorLabel`), the Night and
 * the Doors page all say "Unnamed scanner (gate-…)". One board, one name, on every surface.
 */
const KEY = "5b9d3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e";

describe("removedDoorName", () => {
  it("names an unnamed gate by its code, as the export does", () => {
    expect(removedDoorName({ key: KEY, name: GATE_PLACEHOLDER_NAME, gate_key: null, device_code: "gate-44c103" }))
      .toBe("Unnamed scanner (gate-44c103)");
  });

  it("names a gate whose row kept only its code (the server's fallback name) the same way", () => {
    expect(removedDoorName({ key: KEY, name: "gate-44c103", gate_key: null, device_code: "gate-44c103" }))
      .toBe("Unnamed scanner (gate-44c103)");
  });

  it.each([
    ["the placeholder", GATE_PLACEHOLDER_NAME],
    ["no name at all", null],
    ["a blank name", "  "],
  ])("never shows the device id for %s with no code", (_why, name) => {
    const label = removedDoorName({ key: KEY, name, gate_key: null });
    expect(label).toBe("Unnamed scanner");
    expect(label).not.toContain(KEY);
  });

  it("keeps a club's own name, and the key when that is all there is", () => {
    expect(removedDoorName({ key: KEY, name: "Side door", gate_key: "side-door", device_code: "gate-1" })).toBe("Side door");
    expect(removedDoorName({ key: KEY, name: GATE_PLACEHOLDER_NAME, gate_key: "side-door" })).toBe("side-door");
  });
});
