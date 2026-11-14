import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { themes } from "./lib/tokens";
import { APP_NAME } from "./lib/routeAnnouncer";
import { INDEXABLE_PATHS, SITE_ORIGIN, syncSeoHead } from "./lib/seoHead";

/**
 * The app's face to a browser tab, a home screen, a search engine and a WhatsApp link preview.
 *
 * <p>
 * The icons were a generic blue square with three lines; nothing said squash, or Crusaders.
 * They are now generated from the crest (`brand/crest.svg`, `npm run icons`), and the club —
 * not the software — names the app everywhere. Search: only the public pages are indexable; the
 * signed-in app and invite links (`/j/{token}`, a private token) are not, said three ways that
 * must agree — robots.txt + sitemap, the image's X-Robots-Tag map, and the runtime head.
 * Read from disk: none of these files goes through the bundler.
 * </p>
 */

const ROOT = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p));
const text = (...p: string[]) => read(...p).toString("utf8");
const html = text("index.html");
const manifest = JSON.parse(text("public", "manifest.webmanifest")) as {
  name: string; short_name: string; icons: { src: string; sizes: string; purpose: string }[];
};

const meta = (attr: "name" | "property", key: string) =>
  new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`).exec(html)?.[1] ?? null;

/** Width, height and RGBA of every pixel of an 8-bit non-interlaced PNG (RGB or RGBA). */
function decodePng(buf: Buffer) {
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colourType = buf[25];
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  expect(buf[24], "bit depth").toBe(8);
  expect(channels, "colour type").toBeGreaterThan(0);
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      out[y * stride + x] = (v + predictor) & 0xff;
    }
  }
  const alpha = (x: number, y: number) => (channels === 4 ? out[(y * width + x) * 4 + 3] : 255);
  const rgb = (x: number, y: number) => [0, 1, 2].map((i) => out[(y * width + x) * channels + i]);
  return { width, height, alpha, rgb };
}

const hex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
const crest = text("brand", "crest.svg");

describe("the icons are the club's crest", () => {
  it("the source crest is CrestMark's drawing in the brand tokens", () => {
    const mark = text("src", "components", "shell", "Crest.tsx");
    for (const d of crest.matchAll(/ d="([^"]+)"/g)) expect(mark, "Crest.tsx path").toContain(d[1]);
    expect(crest).toContain(`fill="${themes.light.brand.strong}"`);
    expect(crest).toContain(`fill="${themes.light.brand.tin}"`);
  });

  it("favicon.svg is the crest, not the old three-line square", () => {
    const svg = text("public", "favicon.svg");
    expect(svg).toContain(themes.light.brand.strong);
    expect(svg).toContain(themes.light.brand.tin);
    expect(svg).not.toContain("#0369A1");
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg[^"]*" \/>/);
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.ico[^"]*"/);
  });

  it("favicon.ico carries 16, 32 and 48", () => {
    const ico = read("public", "favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i]);
    expect(sizes).toEqual([16, 32, 48]);
  });

  it.each([
    ["icon-192.png", 192], ["icon-512.png", 512], ["icon-512-maskable.png", 512], ["apple-touch-icon.png", 180],
  ])("%s is %ipx square and draws the crest's navy", (file, size) => {
    const png = decodePng(read("public", file));
    expect([png.width, png.height]).toEqual([size, size]);
    // Inside the shield, clear of the keyline and the cross.
    expect(hex(png.rgb(Math.round(size * 0.38), Math.round(size * 0.62)))).toBe(themes.light.brand.strong.toUpperCase());
  });

  it.each(["icon-512-maskable.png", "apple-touch-icon.png"])("%s is full-bleed and opaque (masks and iOS crop it)", (file) => {
    const png = decodePng(read("public", file));
    for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]]) {
      expect(png.alpha(x, y)).toBe(255);
      expect(hex(png.rgb(x, y))).toBe(themes.light.brand.strong.toUpperCase());
    }
  });

  it("the share image is 1200×630", () => {
    const png = decodePng(read("public", "og-image.png"));
    expect([png.width, png.height]).toEqual([1200, 630]);
  });

  it("the manifest names the club and lists any + maskable icons", () => {
    expect(manifest.name).toBe("Crusaders Squash");
    expect(manifest.name).toBe(APP_NAME);
    expect(manifest.short_name).toBe("Crusaders");
    expect(manifest.icons.map((i) => [i.src.split("?")[0], i.sizes, i.purpose])).toEqual([
      ["/icon-192.png", "192x192", "any"], ["/icon-512.png", "512x512", "any"], ["/icon-512-maskable.png", "512x512", "maskable"],
    ]);
  });
});

describe("search and share metadata", () => {
  it("has a real title, description, language and app name", () => {
    expect(html).toMatch(/<html lang="en-ZA">/);
    expect(/<title>([^<]+)<\/title>/.exec(html)?.[1]).toBe("Crusaders Squash Club — Durban North");
    expect(meta("name", "description")!.length).toBeGreaterThan(70);
    expect(meta("name", "application-name")).toBe(APP_NAME);
    expect(meta("name", "viewport")).toContain("width=device-width");
  });

  it("has Open Graph and Twitter cards with an absolute 1200×630 image", () => {
    expect(meta("property", "og:type")).toBe("website");
    expect(meta("property", "og:site_name")).toBe(APP_NAME);
    expect(meta("property", "og:url")).toBe(`${SITE_ORIGIN}/`);
    expect(meta("property", "og:image")).toBe(`${SITE_ORIGIN}/og-image.png`);
    expect(meta("property", "og:image:width")).toBe("1200");
    expect(meta("property", "og:image:height")).toBe("630");
    expect(meta("property", "og:image:alt")).toBeTruthy();
    expect(meta("property", "og:locale")).toBe("en_ZA");
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
    expect(meta("name", "twitter:image")).toBe(`${SITE_ORIGIN}/og-image.png`);
  });

  it("the JSON-LD parses and uses only the club page's own facts", () => {
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(ld["@type"]).toBe("SportsActivityLocation");
    // The static shell is the first club's (FM-8), so its JSON-LD holds to that club's own page.
    const home = text("src", "clubs", "crusaders", "CrusadersLanding.tsx");
    expect(home).toContain(ld.address.streetAddress);
    expect(home).toContain(ld.address.postalCode);
    expect(home).toContain(ld.hasMap);
    for (const url of ld.sameAs) expect(home).toContain(url);
    expect(ld.telephone).toBeUndefined();
    expect(ld.openingHours).toBeUndefined();
  });
});

describe("only the public pages are indexable", () => {
  const robots = text("public", "robots.txt");
  const sitemap = text("public", "sitemap.xml");
  const nginx = text("nginx.conf").replace(/#.*$/gm, "");

  it("robots.txt disallows invites, the API, admin and the signed-in app", () => {
    for (const path of ["/j/", "/api/", "/admin", "/my-code", "/bookings", "/wallet", "/invites/"]) {
      expect(robots).toMatch(new RegExp(`^Disallow: ${path}$`, "m"));
    }
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  it("the sitemap lists exactly the indexable pages", () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(INDEXABLE_PATHS.map((p) => `${SITE_ORIGIN}${p}`));
  });

  it("the frontend image sends noindex for every document except the indexable pages", () => {
    const map = /map \$request_uri \$robots_tag \{([\s\S]*?)\n\}/.exec(nginx)![1];
    expect(map).toMatch(/default\s+"noindex, nofollow";/);
    const pattern = /~(\S+)\s+"";/.exec(map)![1];
    const indexable = new RegExp(pattern);
    for (const path of INDEXABLE_PATHS) expect(indexable.test(path), path).toBe(true);
    for (const path of ["/j/abc123", "/admin", "/my-code", "/bookings", "/wallet", "/reset-password/x", "/login/extra"]) {
      expect(indexable.test(path), path).toBe(false);
    }
    for (const location of ["/", "= /index.html"]) {
      const at = nginx.indexOf(`location ${location} {`);
      expect(nginx.slice(at, nginx.indexOf("}", at))).toContain("add_header X-Robots-Tag $robots_tag always;");
    }
  });

  it("the icons and robots files are revalidated, not held for a year", () => {
    const icons = nginx.indexOf("location ~ ^/(?:favicon");
    expect(icons).toBeGreaterThan(-1);
    expect(icons).toBeLessThan(nginx.indexOf("location ~* \\.(?:js|css"));
    expect(nginx.slice(icons, nginx.indexOf("}", icons))).toContain('add_header Cache-Control "no-cache" always;');
  });

  it("the runtime head says canonical for a public page and noindex for the app", () => {
    const doc = document.implementation.createHTMLDocument();
    syncSeoHead("/login", doc);
    expect(doc.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(`${SITE_ORIGIN}/login`);
    expect(doc.head.querySelector('meta[name="robots"]')).toBeNull();
    syncSeoHead("/j/secret-token", doc);
    expect(doc.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(doc.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    syncSeoHead("/", doc);
    expect(doc.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(doc.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
  });
});
