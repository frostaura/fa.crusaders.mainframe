import { describe, expect, it } from "vitest";
import { QR_MAX_BYTES, encodeQr, qrPath } from "./qr";

/**
 * The in-house QR encoder.
 *
 * <p>
 * The golden symbol below was produced by an independent encoder (python-qrcode, byte
 * mode, level M, version 1, mask 2) and matched this one module for module — as did
 * every other input tried across versions 1–3 and all eight masks. It is pinned here
 * so a change to placement, masking or the Reed–Solomon stage cannot pass unnoticed:
 * a QR that is subtly wrong still looks like a QR.
 * </p>
 */

const GOLDEN_7K3M9XQ2RD5A_MASK_2 = [
  "111111100110101111111",
  "100000100100101000001",
  "101110101010001011101",
  "101110101001101011101",
  "101110101101101011101",
  "100000101010101000001",
  "111111101010101111111",
  "000000001001100000000",
  "101111100110101111100",
  "000000000000100010000",
  "100000110011001101010",
  "010111001100010000111",
  "111100100011010101010",
  "000000001000100000111",
  "111111100100101001000",
  "100000101001110101100",
  "101110101100100110111",
  "101110101110110001000",
  "101110101001100001100",
  "100000100111100000100",
  "111111101011111111010",
];

function rows(matrix: ReturnType<typeof encodeQr>): string[] {
  const out: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    out.push(Array.from(matrix.modules.slice(y * matrix.size, (y + 1) * matrix.size)).join(""));
  }
  return out;
}

describe("encodeQr", () => {
  it("matches an independent encoder for a twelve-character access code", () => {
    const matrix = encodeQr("7K3M9XQ2RD5A", { mask: 2 });
    expect(matrix.version).toBe(1);
    expect(matrix.size).toBe(21);
    expect(rows(matrix)).toEqual(GOLDEN_7K3M9XQ2RD5A_MASK_2);
  });

  it("picks the smallest version that fits, and never more than three", () => {
    expect(encodeQr("A").version).toBe(1);
    expect(encodeQr("7K3M9XQ2RD5A").version).toBe(1);
    expect(encodeQr("HELLO WORLD 12345").version).toBe(2);
    expect(encodeQr("x".repeat(QR_MAX_BYTES)).version).toBe(3);
    // A payload the box's scanner would poison as too long is refused, not encoded.
    expect(() => encodeQr("x".repeat(QR_MAX_BYTES + 1))).toThrow(/at most 42/);
  });

  it("keeps the finder patterns whatever the mask", () => {
    for (let mask = 0; mask < 8; mask++) {
      const m = encodeQr("7K3M9XQ2RD5A", { mask });
      const at = (x: number, y: number) => m.modules[y * m.size + x];
      // Centre of each finder is dark, the ring one out is light.
      for (const [cx, cy] of [[3, 3], [m.size - 4, 3], [3, m.size - 4]]) {
        expect(at(cx, cy)).toBe(1);
        expect(at(cx + 2, cy)).toBe(0);
        expect(at(cx + 3, cy)).toBe(1);
      }
      expect(m.mask).toBe(mask);
    }
  });

  it("chooses a mask by penalty when none is forced", () => {
    const m = encodeQr("7K3M9XQ2RD5A");
    expect(m.mask).toBeGreaterThanOrEqual(0);
    expect(m.mask).toBeLessThanOrEqual(7);
  });

  it("emits one square per dark module, offset by the quiet zone", () => {
    const m = encodeQr("7K3M9XQ2RD5A", { mask: 2 });
    const path = qrPath(m, 4);
    const dark = Array.from(m.modules).filter((v) => v === 1).length;
    expect(path.match(/h1v1h-1z/g)).toHaveLength(dark);
    // Top-left finder corner lands at (4,4) once the four-module margin is applied.
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
  });
});
