#!/usr/bin/env node
/**
 * Generates every icon and the share image from ONE source: `brand/crest.svg`.
 *
 *   npm run icons
 *
 * Writes into `public/`: favicon.svg, favicon.ico (16/32/48), apple-touch-icon.png (180, opaque),
 * icon-192.png + icon-512.png ("any": the crest on transparent), icon-512-maskable.png (full-bleed
 * navy, crest inside the 80 % safe zone) and og-image.png (1200×630). The outputs are committed;
 * re-run this after editing the crest and commit both.
 *
 * Rasterised with the Chromium Playwright already installs for the e2e suite (no new dependency).
 * On a Mac whose cached revision differs from the one Playwright pins, point it at the cached one:
 * PLAYWRIGHT_CHROMIUM_PATH=… npm run icons (the same variable playwright.config.ts reads).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const SOURCE = readFileSync(join(ROOT, "brand", "crest.svg"), "utf8");

/** The three paths of the crest, comments stripped: the drawing every variant reuses. */
const CREST = [...SOURCE.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]).join("");
const SHIELD_D = /id="shield" d="([^"]+)"/.exec(SOURCE)[1];

const NAVY = "#00498D"; // brand.strong
const WHITE = "#FFFFFF"; // brand.ink

/**
 * The crest on a square canvas. `scale` is the shield's height as a share of the canvas; `bg` a
 * full-bleed fill (null = transparent); `halo` a white outline round the shield, which is what
 * keeps a navy shield readable on a navy tile or dark browser chrome.
 */
function squareSvg({ scale, bg = null, halo = 0, extraStyle = "" }) {
  const side = 36 / scale; // the crest's viewBox is 32×36
  const x = (32 - side) / 2;
  const y = (36 - side) / 2;
  const back = bg ? `<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${bg}"/>` : "";
  const ring = halo ? `<path class="halo" d="${SHIELD_D}" fill="none" stroke="${WHITE}" stroke-width="${halo}" stroke-linejoin="round"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${side} ${side}">${extraStyle}${back}${ring}${CREST}</svg>`;
}

/** The browser tab: the bare crest, with a white halo only under dark browser chrome. */
const FAVICON = squareSvg({
  scale: 0.94,
  halo: 1.6,
  extraStyle: "<style>.halo{display:none}@media (prefers-color-scheme:dark){.halo{display:inline}}</style>",
});

/** Launchers and the desktop install: the crest alone, as large as the canvas allows. */
const ANY = squareSvg({ scale: 0.9 });

/**
 * Full-bleed navy tile with a haloed crest. Maskable: the shield's 36-unit height is 62 % of the
 * side, so its corners sit inside the 80 % safe circle; iOS (apple-touch) ignores transparency
 * and rounds the corners itself, so it gets the same tile a little larger.
 */
const MASKABLE = squareSvg({ scale: 0.62, bg: NAVY, halo: 1.4 });
const APPLE = squareSvg({ scale: 0.72, bg: NAVY, halo: 1.4 });

const FONT = readFileSync(join(ROOT, "src", "assets", "fonts", "archivo-display.woff2")).toString("base64");

/** The share card WhatsApp, iMessage and Slack draw for a link: crest and the club's name. */
const OG_HTML = `<!doctype html><html><head><style>
@font-face{font-family:Archivo;src:url(data:font/woff2;base64,${FONT}) format("woff2");font-weight:600 800;font-stretch:100% 112%}
html,body{margin:0}
.card{width:1200px;height:630px;box-sizing:border-box;background:#F8FAFC;display:flex;align-items:center;gap:64px;padding:0 96px;position:relative;font-family:Archivo,sans-serif;color:#0F172A}
.card svg{height:380px;width:auto;flex:none}
h1{margin:0;font-size:104px;line-height:1;font-weight:800;font-stretch:108%;letter-spacing:-2px;color:${NAVY}}
p{margin:28px 0 0;font-size:40px;font-weight:600;color:#475569}
.tin{position:absolute;left:0;right:0;bottom:0;height:18px;background:#CF2E30}
</style></head><body><div class="card">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 36">${CREST}</svg>
<div><h1>Crusaders<br>Squash</h1><p>Durban North · KwaZulu-Natal</p><p style="margin-top:12px;font-size:30px;white-space:nowrap">Book a court and switch on the lights.</p></div>
<div class="tin"></div></div></body></html>`;

/** A PNG-payload .ico (Vista+; every current browser and crawler reads it). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(html, width, height, transparent) {
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ type: "png", omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
}

const svgPage = (svg, size) =>
  `<!doctype html><html><body style="margin:0"><div style="width:${size}px;height:${size}px">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div></body></html>`;

writeFileSync(join(PUBLIC, "favicon.svg"), `${FAVICON}\n`);
writeFileSync(join(PUBLIC, "icon-192.png"), await render(svgPage(ANY, 192), 192, 192, true));
writeFileSync(join(PUBLIC, "icon-512.png"), await render(svgPage(ANY, 512), 512, 512, true));
writeFileSync(join(PUBLIC, "icon-512-maskable.png"), await render(svgPage(MASKABLE, 512), 512, 512, false));
writeFileSync(join(PUBLIC, "apple-touch-icon.png"), await render(svgPage(APPLE, 180), 180, 180, false));
const small = [];
for (const size of [16, 32, 48]) small.push({ size, data: await render(svgPage(FAVICON, size), size, size, true) });
writeFileSync(join(PUBLIC, "favicon.ico"), ico(small));
writeFileSync(join(PUBLIC, "og-image.png"), await render(OG_HTML, 1200, 630, false));

await browser.close();
console.log("icons written to public/");
