/**
 * What a search engine may index, and the head tags that say so per route.
 *
 * <p>
 * This is a members' club app: only the club's public page and the ways in are worth a search
 * result. Everything else is behind sign-in, and an invite link (`/j/{token}`) carries a secret
 * that must never be indexed. Three mechanisms say the same thing and `seo-posture.test.ts`
 * holds them to this list: `public/robots.txt` + `public/sitemap.xml`, the frontend image's
 * `X-Robots-Tag` map (`nginx.conf`, the robust one — it reaches crawlers that run no script),
 * and {@link syncSeoHead}, which the route announcer calls on every navigation.
 * </p>
 *
 * <p>
 * The canonical is per route rather than one static tag in `index.html`: a single canonical
 * would tell a crawler that /login and /register are the home page. One origin is acceptable
 * because this deployment serves one club; it is also `App__PublicBaseUrl` in
 * docker-compose.prod.yml.
 * </p>
 */
export const SITE_ORIGIN = "https://crusaders.frostaura.net";

/** The public, indexable pages — exact paths. Everything else is noindex. */
export const INDEXABLE_PATHS: readonly string[] = ["/", "/login", "/register", "/forgot-password", "/how-it-works"];

export const isIndexable = (pathname: string) => INDEXABLE_PATHS.includes(pathname);

function headTag<T extends Element>(selector: string, create: () => T, doc: Document): T {
  return (doc.head.querySelector(selector) as T | null) ?? doc.head.appendChild(create());
}

/** Sets the canonical link and the robots meta for the route now shown. */
export function syncSeoHead(pathname: string, doc: Document = document): void {
  const canonical = doc.head.querySelector('link[rel="canonical"]');
  const robots = doc.head.querySelector('meta[name="robots"]');
  if (isIndexable(pathname)) {
    robots?.remove();
    const link = headTag('link[rel="canonical"]', () => Object.assign(doc.createElement("link"), { rel: "canonical" }), doc);
    link.setAttribute("href", `${SITE_ORIGIN}${pathname}`);
  } else {
    canonical?.remove();
    const meta = headTag('meta[name="robots"]', () => Object.assign(doc.createElement("meta"), { name: "robots" }), doc);
    meta.setAttribute("content", "noindex, nofollow");
  }
}
