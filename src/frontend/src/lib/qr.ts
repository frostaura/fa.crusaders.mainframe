/**
 * A QR encoder small enough to own.
 *
 * <p>
 * The court box's scanner pipeline carries at most 24 bytes per argument, and the code a
 * member shows it is twelve characters of Crockford base32 (see `AccessCode` on the API).
 * That is a version-1 symbol. A general-purpose QR library brings thirty-nine more versions,
 * four encodings, Kanji tables and an image pipeline for a payload that will never leave
 * version 3 — so this is byte mode, error-correction level M, versions 1–3, and nothing else.
 * Anything longer than 44 bytes is refused rather than silently encoded into something the
 * box would poison as too long anyway.
 * </p>
 *
 * <p>
 * Structure follows ISO/IEC 18004 and the widely-reproduced reference layout (finder and
 * timing patterns, single alignment pattern from version 2, zigzag placement skipping the
 * vertical timing column, all eight masks scored by the four penalty rules, BCH-protected
 * format bits). Verified module-for-module against an independent encoder for every
 * version and mask this supports.
 * </p>
 */

export type QrMatrix = {
  /** Modules per side. 21 for version 1, 25 for version 2, 29 for version 3. */
  size: number;
  /** Row-major, `size * size` entries; 1 is dark. */
  modules: Uint8Array;
  version: number;
  mask: number;
};

/** Byte-mode capacity at level M for each supported version. */
const DATA_CODEWORDS: Record<number, number> = { 1: 16, 2: 28, 3: 44 };
const EC_CODEWORDS: Record<number, number> = { 1: 10, 2: 16, 3: 26 };

/** The most bytes this encoder will take: version 3-M, less the 12-bit mode/length header. */
export const QR_MAX_BYTES = DATA_CODEWORDS[3] - 2;

// --- GF(256) arithmetic for Reed–Solomon ------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Coefficients of ∏(x − α^i) for i < degree, highest power first, leading 1 included. */
function generatorPolynomial(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function reedSolomon(data: Uint8Array, degree: number): Uint8Array {
  const gen = generatorPolynomial(degree);
  const rem = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < degree; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

// --- bit-level data segment --------------------------------------------------

function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const dataCapacity = DATA_CODEWORDS[version];
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);          // byte mode
  push(bytes.length, 8);    // character count, 8 bits for versions 1–9
  for (const b of bytes) push(b, 8);

  // Terminator, up to four zeros, then pad to a byte boundary.
  const capacityBits = dataCapacity * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(dataCapacity);
  for (let i = 0; i < bits.length; i++) data[i >>> 3] |= bits[i] << (7 - (i & 7));
  // Alternating pad codewords fill what the message did not.
  for (let i = bits.length / 8, pad = 0xec; i < dataCapacity; i++, pad ^= 0xec ^ 0x11) data[i] = pad;

  const ec = reedSolomon(data, EC_CODEWORDS[version]);
  const out = new Uint8Array(dataCapacity + ec.length);
  out.set(data);
  out.set(ec, dataCapacity);
  return out;
}

// --- the symbol ---------------------------------------------------------------

class QrSymbol {
  readonly size: number;
  readonly modules: Uint8Array;
  readonly isFunction: Uint8Array;

  constructor(readonly version: number) {
    this.size = 17 + version * 4;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }

  private set(x: number, y: number, dark: boolean, fn = false) {
    const i = y * this.size + x;
    this.modules[i] = dark ? 1 : 0;
    if (fn) this.isFunction[i] = 1;
  }

  get(x: number, y: number): boolean {
    return this.modules[y * this.size + x] === 1;
  }

  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0, true);
      this.set(i, 6, i % 2 === 0, true);
    }
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);
    if (this.version >= 2) {
      const c = n - 7;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          this.set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
        }
      }
    }
    // Reserve the format areas so data placement skips them; the real bits land after masking.
    this.drawFormatBits(0);
  }

  private drawFinder(cx: number, cy: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, dist !== 2 && dist !== 4, true);
      }
    }
  }

  drawFormatBits(mask: number) {
    // Level M is 00 in the format field.
    const data = mask & 7;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const n = this.size;

    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i), true);
    this.set(8, 7, bit(6), true);
    this.set(8, 8, bit(7), true);
    this.set(7, 8, bit(8), true);
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i), true);

    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i), true);
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i), true);
    this.set(8, n - 8, true, true);
  }

  drawCodewords(codewords: Uint8Array) {
    const n = this.size;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          const idx = y * n + x;
          if (this.isFunction[idx] === 0 && i < total) {
            this.modules[idx] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const idx = y * n + x;
        if (this.isFunction[idx] === 1) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[idx] ^= 1;
      }
    }
  }

  penalty(): number {
    const n = this.size;
    let score = 0;

    // Rule 1: runs of five or more in a row or column. Rule 3: finder-like 1011101 runs
    // with four light modules on one side, scanned on the same pass.
    for (let axis = 0; axis < 2; axis++) {
      for (let a = 0; a < n; a++) {
        let line = "";
        let runColor = false;
        let runLength = 0;
        for (let b = 0; b < n; b++) {
          const dark = axis === 0 ? this.get(b, a) : this.get(a, b);
          line += dark ? "1" : "0";
          if (b > 0 && dark === runColor) {
            runLength++;
            if (runLength === 5) score += 3;
            else if (runLength > 5) score += 1;
          } else {
            runColor = dark;
            runLength = 1;
          }
        }
        score += 40 * (countOverlapping(line, "00001011101") + countOverlapping(line, "10111010000"));
      }
    }

    // Rule 2: 2×2 blocks of one colour.
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = this.get(x, y);
        if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) score += 3;
      }
    }

    // Rule 4: dark-module proportion away from 50%.
    let dark = 0;
    for (const m of this.modules) dark += m;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += k * 10;

    return score;
  }
}

function countOverlapping(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}

/**
 * Encodes `text` (UTF-8) as a QR matrix. Picks the smallest of versions 1–3 at level M
 * that holds it, and the mask with the lowest penalty. Throws when the text needs more
 * than {@link QR_MAX_BYTES} bytes — a payload that size does not belong in front of the
 * court box's scanner.
 */
export function encodeQr(text: string, options?: { mask?: number }): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = [1, 2, 3].find((v) => bytes.length <= DATA_CODEWORDS[v] - 2);
  if (version === undefined) {
    throw new Error(`QR payload is ${bytes.length} bytes; this encoder carries at most ${QR_MAX_BYTES}.`);
  }

  const codewords = buildCodewords(bytes, version);
  const candidates = options?.mask !== undefined ? [options.mask & 7] : [0, 1, 2, 3, 4, 5, 6, 7];

  let best: { symbol: QrSymbol; mask: number; score: number } | null = null;
  for (const mask of candidates) {
    const symbol = new QrSymbol(version);
    symbol.drawFunctionPatterns();
    symbol.drawCodewords(codewords);
    symbol.applyMask(mask);
    symbol.drawFormatBits(mask);
    const score = symbol.penalty();
    if (best === null || score < best.score) best = { symbol, mask, score };
  }

  return { size: best!.symbol.size, modules: best!.symbol.modules, version, mask: best!.mask };
}

/**
 * The dark modules of a matrix as one SVG path, one unit per module, with `quietZone`
 * modules of margin on every side. Pair with `viewBox="0 0 ${size + 2 * quietZone} …"`.
 */
export function qrPath(matrix: QrMatrix, quietZone = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y * matrix.size + x] === 1) {
        parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
      }
    }
  }
  return parts.join("");
}
