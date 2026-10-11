import { afterEach, describe, expect, it, vi } from "vitest";

import { memberCodeAt } from "./derive";
import { fromHex, hmac, hotp, importHmacKey, isSoftHmacKey, subtle, toHex } from "./hotp";
import { hmacSha256, sha256 } from "./sha256";

const ascii = (s: string) => new TextEncoder().encode(s);

/** A seeded byte generator, so a failure names inputs that reproduce. */
function bytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe("sha256 (the no-WebCrypto fallback)", () => {
  it("matches the FIPS 180-4 vectors", () => {
    expect(toHex(sha256(ascii("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(toHex(sha256(ascii("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(toHex(sha256(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches RFC 4231 HMAC-SHA-256 test cases 1, 2 and 6 (a key longer than a block)", () => {
    expect(toHex(hmacSha256(new Uint8Array(20).fill(0x0b), ascii("Hi There"))))
      .toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    expect(toHex(hmacSha256(ascii("Jefe"), ascii("what do ya want for nothing?"))))
      .toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(toHex(hmacSha256(new Uint8Array(131).fill(0xaa), ascii("Test Using Larger Than Block-Size Key - Hash Key First"))))
      .toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });

  it("agrees with WebCrypto across key and message lengths around every padding boundary", async () => {
    for (const keyLength of [1, 12, 32, 63, 64, 65, 131]) {
      for (const dataLength of [0, 1, 8, 55, 56, 63, 64, 65, 119, 120, 200]) {
        const key = bytes(keyLength * 1000 + dataLength + 1, keyLength);
        const data = bytes(dataLength * 7 + keyLength + 3, dataLength);
        const webCryptoKey = await subtle().importKey("raw", key.slice(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const expected = new Uint8Array(await subtle().sign("HMAC", webCryptoKey, data.slice()));
        expect(toHex(hmacSha256(key, data)), `key ${keyLength} B, data ${dataLength} B`).toBe(toHex(expected));
      }
    }
  });
});

describe("a page with no WebCrypto (plain http to the club's LAN server)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** What `crypto` looks like on an insecure origin: present, with no `subtle`. */
  function withoutSubtle() {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  }

  it("imports a soft key and keeps a copy of the bytes, so the caller may zero its own", async () => {
    withoutSubtle();
    const raw = fromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    const key = await importHmacKey(raw);
    raw.fill(0);
    expect(isSoftHmacKey(key)).toBe(true);
    expect(toHex(await hmac(key, ascii("x")))).toBe(
      toHex(hmacSha256(fromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"), ascii("x"))),
    );
  });

  it("makes the same member code as WebCrypto does, day key and all", async () => {
    const secret = bytes(42, 32);
    const step = 59_000_000;
    const withWebCrypto = await memberCodeAt(await importHmacKey(secret), "AB12", "Africa/Johannesburg", step);
    const webCryptoOn = await hotp(await importHmacKey(secret), step, 8);

    withoutSubtle();
    const soft = await importHmacKey(secret);
    expect(isSoftHmacKey(soft)).toBe(true);
    const withSoftKey = await memberCodeAt(soft, "AB12", "Africa/Johannesburg", step);

    expect(withSoftKey).toEqual(withWebCrypto);
    expect(withSoftKey.on).toBe(webCryptoOn);
  });
});
