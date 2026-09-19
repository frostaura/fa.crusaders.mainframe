import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { preparePhoto, PhotoError, MAX_UPLOAD_BYTES } from "./photo";

/**
 * jsdom has neither `createImageBitmap` nor a canvas that can encode, so every test here
 * installs its own. That is not a workaround for the test environment — the production code
 * feature-detects exactly this pair, and one of the cases below is the fallback that detection
 * takes. See `canReencode` in photo.ts.
 */

type CanvasStub = {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
};

let canvas: CanvasStub;
let ctx: { fillStyle: string; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> };
let createdCanvases: CanvasStub[];
let blobSizes: number[];
let realCreateImageBitmap: unknown;

/** Sizes the stubbed `toBlob` returns, in call order; the last value repeats. */
function encodesAt(...sizes: number[]) {
  blobSizes = sizes;
}

function installCanvas() {
  createdCanvases = [];
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    let call = 0;
    canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toBlob: vi.fn((cb: (b: Blob | null) => void) => {
        const size = blobSizes[Math.min(call, blobSizes.length - 1)];
        call += 1;
        cb(size < 0 ? null : new Blob([new Uint8Array(size)], { type: "image/jpeg" }));
      }),
    };
    createdCanvases.push(canvas);
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
}

function bitmapOf(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

/** A picked file. Only name and type matter — the bytes never reach the real decoder. */
function pick(name: string, type: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeEach(() => {
  ctx = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  blobSizes = [200 * 1024];
  realCreateImageBitmap = (globalThis as Record<string, unknown>).createImageBitmap;
  (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(async () => bitmapOf(800, 600));
  installCanvas();
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as Record<string, unknown>).createImageBitmap = realCreateImageBitmap;
});

describe("preparePhoto", () => {
  it("re-encodes an iPhone HEIC as a JPEG the API's allow-list accepts", async () => {
    const out = await preparePhoto(pick("IMG_4021.HEIC", "image/heic"));

    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_4021.jpg");
  });

  /**
   * The bug this guards is invisible and permanent: a canvas draw drops EXIF, so without the
   * orientation hint every portrait photo taken on a phone is STORED rotated. Nothing
   * downstream can recover it, because the tag is gone from the re-encoded file.
   */
  it("applies the EXIF orientation tag while decoding", async () => {
    await preparePhoto(pick("portrait.jpg", "image/jpeg"));

    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(expect.any(File), { imageOrientation: "from-image" });
  });

  it("downscales a 12-megapixel camera photo to a 1600px longest edge, keeping its shape", async () => {
    (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(async () => bitmapOf(4032, 3024));

    await preparePhoto(pick("DSC_0001.jpg", "image/jpeg"));

    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200); // 4032:3024 is 4:3 — preserved exactly.
  });

  it("leaves an already-small photo at its own size rather than upscaling it", async () => {
    (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(async () => bitmapOf(320, 240));

    await preparePhoto(pick("small.png", "image/png"));

    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(240);
  });

  /**
   * A 4000x1 strip scales to a height of 0.4px. Rounded down that is a zero-height canvas, and
   * drawImage throws on it — so the member gets "we couldn't prepare that photo" for an image
   * that is merely an odd shape.
   */
  it("keeps at least one pixel of height on an extreme panorama", async () => {
    (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(async () => bitmapOf(4000, 1));

    await preparePhoto(pick("pano.jpg", "image/jpeg"));

    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1);
  });

  /**
   * JPEG has no alpha. A transparent PNG drawn straight onto a fresh canvas encodes as BLACK
   * wherever it was transparent — on a cut-out head-and-shoulders photo that is a black
   * rectangle around the member, on every screen, forever.
   */
  it("flattens transparency onto white before encoding", async () => {
    await preparePhoto(pick("cutout.png", "image/png"));

    expect(ctx.fillStyle).toBe("#FFFFFF");
    expect(ctx.fillRect).toHaveBeenCalled();
    // Order matters: a fill after the draw would paint over the photo entirely.
    expect(ctx.fillRect.mock.invocationCallOrder[0]).toBeLessThan(ctx.drawImage.mock.invocationCallOrder[0]);
  });

  it("retries at a lower quality when the first encode overshoots the cap", async () => {
    encodesAt(MAX_UPLOAD_BYTES + 1, 900 * 1024);

    const out = await preparePhoto(pick("noisy.jpg", "image/jpeg"));

    expect(canvas.toBlob).toHaveBeenCalledTimes(2);
    expect(canvas.toBlob.mock.calls[1][2]).toBeLessThan(canvas.toBlob.mock.calls[0][2]);
    expect(out.size).toBe(900 * 1024);
  });

  it("gives up with still_too_large when even the retry overshoots", async () => {
    encodesAt(MAX_UPLOAD_BYTES + 1, MAX_UPLOAD_BYTES + 1);

    await expect(preparePhoto(pick("huge.jpg", "image/jpeg"))).rejects.toMatchObject({
      name: "PhotoError",
      problem: "still_too_large",
    });
  });

  it("reports a PDF as not an image rather than trying to decode it", async () => {
    await expect(preparePhoto(pick("membership.pdf", "application/pdf"))).rejects.toMatchObject({
      problem: "not_an_image",
    });
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
  });

  /** Some pickers report an empty type for HEIC; the extension is the only signal left. */
  it("still treats a typeless HEIC as an image", async () => {
    await expect(preparePhoto(pick("IMG_0007.heic", ""))).resolves.toMatchObject({ type: "image/jpeg" });
  });

  it("reports undecodable when the browser cannot read the format", async () => {
    (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(async () => {
      throw new DOMException("unsupported source", "InvalidStateError");
    });

    await expect(preparePhoto(pick("IMG_1.heic", "image/heic"))).rejects.toMatchObject({
      problem: "undecodable",
    });
  });

  it("reports encode_failed when the canvas yields no blob", async () => {
    encodesAt(-1);

    await expect(preparePhoto(pick("x.jpg", "image/jpeg"))).rejects.toMatchObject({ problem: "encode_failed" });
  });

  it("releases the decoded bitmap even when encoding fails", async () => {
    const bitmap = bitmapOf(800, 600);
    (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(async () => bitmap);
    encodesAt(-1);

    await expect(preparePhoto(pick("x.jpg", "image/jpeg"))).rejects.toBeInstanceOf(PhotoError);
    expect(bitmap.close).toHaveBeenCalled();
  });

  /**
   * The fallback the production feature-detection takes. Refusing instead would turn "this
   * browser lacks an API" into "you cannot join the club" for an ordinary JPEG that would have
   * uploaded perfectly well untouched.
   */
  it("passes the original file straight through when the browser cannot re-encode", async () => {
    (globalThis as Record<string, unknown>).createImageBitmap = undefined;
    const original = pick("plain.jpg", "image/jpeg", 2048);

    const out = await preparePhoto(original);

    expect(out).toBe(original);
  });
});
