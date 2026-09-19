import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";

export default function HomePage() {
  const auth = useAuth();
  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <p className="text-sm uppercase tracking-wider text-text-muted">FrostAura Technologies</p>
        <h1 className="text-3xl font-semibold tracking-tight">Crusaders Mainframe</h1>
        <p className="text-text-secondary mt-2">
          Court-light scheduling on a credit + on-court biometric model. Multi-tenant SaaS for racquet-sport clubs;
          first customer is Crusaders Squash Club.
        </p>
      </header>

      <Card>
        {auth.status === "authenticated" ? (
          <div className="flex flex-wrap gap-3">
            <Link to="/schedule" className="text-accent-strong font-medium hover:underline">Open the schedule →</Link>
            <Link to="/court-code" className="text-text-secondary hover:underline">Show your court code</Link>
            <Link to="/wallet" className="text-text-secondary hover:underline">View wallet</Link>
            {auth.isAdmin && <Link to="/admin/members" className="text-text-secondary hover:underline">Admin · Members</Link>}
          </div>
        ) : (
          <div className="flex gap-3">
            <Link to="/login" className="text-accent-strong font-medium hover:underline">Sign in</Link>
            <Link to="/register" className="text-text-secondary hover:underline">Register</Link>
          </div>
        )}
      </Card>
    </div>
  );
}
