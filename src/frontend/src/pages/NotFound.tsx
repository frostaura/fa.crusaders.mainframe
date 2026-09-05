import { Link } from "react-router-dom";
import { Card } from "../components/Card";

/**
 * What an unknown URL renders.
 *
 * <p>
 * The catch-all route used to be <code>&lt;Navigate to="/" replace /&gt;</code>, which silently
 * turned every mistyped, renamed or not-yet-built path into the marketing home page. That is
 * how the missing password-reset routes stayed invisible for as long as they did: the reset
 * email's link "worked", landed somewhere plausible, and told nobody it had gone nowhere. A
 * dead end that announces itself is worth more than a redirect that hides one.
 * </p>
 */
export default function NotFoundPage() {
  return (
    <div className="max-w-md mx-auto p-4">
      <Card>
        <h1 className="text-xl font-semibold text-text-primary">Page not found</h1>
        <p className="mt-2 text-text-secondary">
          We couldn't find that page. The link may be out of date, or the address may have a typo in it.
        </p>
        <div className="mt-4 flex flex-wrap gap-4">
          <Link className="text-accent-strong underline" to="/">Go to the home page</Link>
          <Link className="text-accent-strong underline" to="/schedule">Book a court</Link>
        </div>
      </Card>
    </div>
  );
}
