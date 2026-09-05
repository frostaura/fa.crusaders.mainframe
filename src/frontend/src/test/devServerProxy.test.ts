import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The dev server and nginx must proxy the same paths to the API.
 *
 * <p>
 * They did not, and the consequence was quiet. The API stores a member's photo as a
 * relative path (<code>/uploads/&lt;tenant&gt;/photos/&lt;hash&gt;.png</code>), so the browser
 * resolves it against the <b>web</b> origin. nginx has carried <code>location /uploads/</code>
 * since it was written; Vite proxied only <code>/api</code> and <code>/healthz</code> and
 * answered every photo with the SPA's <code>index.html</code> — status 200, content-type
 * text/html, and an <code>&lt;img&gt;</code> with <code>naturalWidth: 0</code>.
 * </p>
 *
 * <p>
 * So every photo a developer or a QA run produced was a broken image, while the five seeded
 * members (whose photos are <code>data:</code> URIs) rendered fine and hid it. Photo-on-the-grid
 * is a stated identification mechanism and the reason photo upload is mandatory at
 * registration — it could not be seen working locally at all.
 * </p>
 *
 * <p>
 * This reads the two config files as text on purpose. Importing <code>vite.config.ts</code>
 * would evaluate it, and the point is to compare what the two deployments are configured to
 * do, not what one of them does at runtime.
 * </p>
 */
describe("dev server and nginx proxy the same paths", () => {
  const root = resolve(__dirname, "../..");
  const viteConfig = readFileSync(resolve(root, "vite.config.ts"), "utf8");
  const nginxConf = readFileSync(resolve(root, "../../nginx/nginx.conf"), "utf8");

  it.each(["/api", "/healthz", "/uploads"])("Vite forwards %s to the API", (path) => {
    expect(viteConfig).toContain(`"${path}": {`);
  });

  /**
   * Paths nginx forwards that the dev server deliberately does not.
   *
   * Listed rather than filtered out silently, so that adding an nginx location forces
   * somebody to decide which side of this line it is on.
   *
   * `/graphql` is forwarded to a backend path that does not exist — the API exposes no
   * GraphQL endpoint at all. That is its own finding (E-F17) and belongs to whoever owns
   * the gateway config; mirroring a route to nowhere into the dev server would only make
   * the dead route harder to notice.
   */
  const NOT_PROXIED_IN_DEV = new Set(["/graphql"]);

  it("proxies every path nginx proxies, so a photo is not a broken image in dev", () => {
    // Every `location /x { proxy_pass ... }` in the production config.
    const proxied = Array.from(nginxConf.matchAll(/location\s+=?\s*(\/[a-z0-9_-]+)\/?\s*\{[^}]*proxy_pass/gis))
      .map((m) => m[1]);

    expect(proxied).toContain("/uploads");
    for (const path of proxied) {
      if (NOT_PROXIED_IN_DEV.has(path)) continue;
      expect(viteConfig, `nginx proxies ${path} and the dev server does not`).toContain(`"${path}"`);
    }
  });
});
