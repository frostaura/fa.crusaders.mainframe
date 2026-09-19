/**
 * Turns whatever a phone's photo picker hands us into something the API accepts and a browser
 * can render back.
 *
 * <p>
 * The upload endpoint accepts exactly <c>image/jpeg</c>, <c>image/png</c>, <c>image/webp</c> and
 * <c>image/gif</c>, and caps the body. A real member registering on a real phone routinely
 * breaks both: an iPhone hands over <c>image/heic</c>, and any recent camera produces a file
 * several times the cap. Both were rejected by the server, and the register screen reported the
 * rejection as "check your connection".
 * </p>
 *
 * <p>
 * Widening the server's allow-list would not have fixed it, because it would have stored bytes
 * no browser can display: the member's photo would upload successfully and then render as a
 * broken image on the admin's approval screen and beside their name on court — a worse failure
 * than the rejection, because nothing reports it. Re-encoding in the browser is what actually
 * solves it. The canvas decodes whatever the operating system can read, including HEIC on iOS,
 * and always emits JPEG.
 * </p>
 *
 * <p>
 * It also fixes rotation. Phone cameras record orientation in EXIF rather than rotating the
 * pixels, and a canvas draw drops EXIF — so a portrait photo re-encoded naively comes out on its
 * side, permanently, for every member who used a phone. <c>imageOrientation: "from-image"</c> is
 * what applies the tag while decoding.
 * </p>
 */

/** Longest edge of the stored photo. Ample for an avatar and a court-side identification shot. */
const MAX_EDGE_PX = 1600;

/** JPEG quality. 0.85 is the knee — visually clean, and a fraction of the original's size. */
const JPEG_QUALITY = 0.85;

/**
 * What the server will take. Kept a little under its own limit: the multipart envelope adds a
 * few hundred bytes, and a re-encode that lands on exactly the boundary is a rejection the
 * member cannot diagnose.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type PhotoProblem =
  /** The picked file is not an image at all. */
  | "not_an_image"
  /** This browser cannot decode the format — HEIC picked on a desktop browser, typically. */
  | "undecodable"
  /** Decoded fine, but re-encoding produced nothing. Canvas unavailable or tainted. */
  | "encode_failed"
  /** Still over the cap after a full downscale. A pathological image, not a normal photo. */
  | "still_too_large";

/**
 * A photo that could not be prepared, carrying WHICH way it failed so the screen can say
 * something true about it instead of one sentence for four causes.
 */
export class PhotoError extends Error {
  constructor(public problem: PhotoProblem, public detail?: string) {
    super(problem);
    this.name = "PhotoError";
  }
}

/** Some browsers report an empty type for HEIC rather than `image/heic`; fall back to the name. */
function looksLikeAnImage(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i.test(file.name);
}

/**
 * Whether this environment can decode and re-encode an image at all.
 *
 * Both halves matter and they are separate capabilities: jsdom (and a handful of very old
 * browsers) provide neither, while some environments provide `createImageBitmap` and a canvas
 * that cannot produce a blob. Probing for the pair is what keeps the fallback honest.
 */
function canReencode(): boolean {
  if (typeof createImageBitmap !== "function") return false;
  if (typeof document === "undefined") return false;
  const probe = document.createElement("canvas");
  return typeof probe.getContext === "function" && typeof probe.toBlob === "function";
}

function scaleToFit(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE_PX) return { width, height };
  const ratio = MAX_EDGE_PX / longest;
  // At least 1px in each direction — a 4000x1 panorama must not scale to a zero-height canvas,
  // which throws on drawImage rather than producing a small picture.
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    // `from-image` applies the EXIF orientation tag. Without it every portrait photo taken on a
    // phone is stored rotated, and nothing downstream can recover the original orientation.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (cause) {
    throw new PhotoError("undecodable", cause instanceof Error ? cause.message : undefined);
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * Decodes, rotates, downscales and re-encodes a picked file as a JPEG within the upload cap.
 *
 * Returns the prepared file. Throws {@link PhotoError} — never a bare Error — so the caller can
 * tell the member which of the four distinct things went wrong.
 */
export async function preparePhoto(file: File): Promise<File> {
  if (!looksLikeAnImage(file)) {
    throw new PhotoError("not_an_image", file.type || file.name);
  }

  // Where the browser cannot re-encode at all, send the original and let the API judge it.
  //
  // Refusing here instead would be strictly worse: an ordinary JPEG under the cap uploads
  // perfectly well without our help, and turning "this browser lacks an API" into "you cannot
  // register" would lock out the exact long-tail browser a club member is most likely to be on.
  // The formats that genuinely need re-encoding still get an honest refusal — from the server,
  // whose codes this screen now maps.
  if (!canReencode()) return file;

  const bitmap = await decode(file);
  try {
    const { width, height } = scaleToFit(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoError("encode_failed", "no 2d context");
    // Photos are drawn onto white rather than onto transparency: a PNG with an alpha channel
    // re-encodes to JPEG with black wherever it was transparent, which on a head-and-shoulders
    // cut-out is a black rectangle around the member.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    // One retry at lower quality covers the rare photo that is still large after downscaling —
    // high-noise, high-detail images compress badly. Beyond that it is not a normal photo and
    // saying so is better than degrading it into mush.
    let blob = await toBlob(canvas, JPEG_QUALITY);
    if (blob && blob.size > MAX_UPLOAD_BYTES) blob = await toBlob(canvas, 0.6);
    if (!blob) throw new PhotoError("encode_failed");
    if (blob.size > MAX_UPLOAD_BYTES) throw new PhotoError("still_too_large", `${Math.round(blob.size / 1024)}KB`);

    const base = file.name.replace(/\.[^./\\]+$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } finally {
    // Frees the decoded surface immediately rather than at the next GC. A member who picks
    // several photos in a row on a phone is otherwise holding tens of megabytes of bitmaps.
    bitmap.close?.();
  }
}

/** Sentences for each way {@link preparePhoto} can fail. */
export const PHOTO_MESSAGES: Record<PhotoProblem, string> = {
  not_an_image: "That file isn't an image. Pick a photo — a JPEG, PNG or HEIC from your camera roll is fine.",
  undecodable:
    "This browser couldn't read that image. If it's an iPhone HEIC photo, try opening it in Photos and sharing it as a JPEG — or register from your phone instead.",
  encode_failed: "We couldn't prepare that photo in this browser. Try a different photo, or register from your phone.",
  still_too_large: "That photo is unusually large even after resizing. Try a different one.",
};
