import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { endpoints, ApiError, errorCode, uploadPhoto } from "../lib/api";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";

/**
 * The API's refusal codes, as sentences.
 *
 * <p>
 * This screen used to map by status alone: every 400 became "password must be at least 8
 * characters", so a member who left their name blank was told to fix a password that was
 * already fine. And a membership number that was already taken produced an unhandled 500 and
 * "Registration failed. Try again." — advice that could never work, on the most ordinary human
 * mistake there is: typing a digit of someone else's club number.
 * </p>
 */
const MESSAGES: Record<string, string> = {
  missing_fields: "Please fill in every field — name, email, membership number and password.",
  password_too_short: "Your password must be at least 8 characters.",
  email_in_use: "An account with that email already exists. Sign in instead, or reset your password.",
  membership_number_in_use:
    "That membership number is already registered. Check the number on your card — if it's right, contact the club committee.",
};

export default function RegisterPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [membershipNumber, setMembershipNumber] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!photo) {
      setError("Please upload a photo of yourself — it's used to identify you on court.");
      return;
    }
    setLoading(true);
    try {
      const upload = await uploadPhoto(photo);
      await endpoints.register({ email, password, fullName, membershipNumber, photoUrl: upload.url });
      setSubmitted(true);
    } catch (err) {
      const code = errorCode(err);
      if (code && MESSAGES[code]) setError(MESSAGES[code]);
      else if (err instanceof ApiError && err.status === 409) setError("Those details are already registered. Sign in instead, or reset your password.");
      else if (err instanceof ApiError && err.status === 429) setError("Too many attempts. Wait a minute, then try again.");
      else setError("Couldn't submit your application. Check your connection and try again — if it keeps failing, contact the club committee.");
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="max-w-md mx-auto pt-6">
        <Card>
          <h1 className="text-xl font-semibold mb-2">Check your inbox</h1>
          <p className="text-sm text-text-secondary mb-4">We've emailed you a link to verify your address. After that, an admin reviews your application.</p>
          <Button variant="outline" onClick={() => nav("/login")} className="w-full">Back to sign in</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto pt-6">
      <Card>
        <h1 className="text-xl font-semibold mb-1">Register</h1>
        <p className="text-sm text-text-secondary mb-5">Join Crusaders Squash Club via Crusaders Mainframe.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="fullName">Full name</Label>
            <Input id="fullName" required value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="membershipNumber">Membership number</Label>
            <Input id="membershipNumber" required value={membershipNumber} onChange={(e) => setMembershipNumber(e.target.value)} placeholder="As issued by the club" />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <p className="text-xs text-text-muted mt-1">At least 8 characters.</p>
          </div>
          <div>
            <Label htmlFor="photo">Photo of yourself</Label>
            <Input id="photo" type="file" accept="image/*" required onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-text-muted mt-1">Used so other players can identify you on court.</p>
          </div>
          {error && <p className="text-sm text-danger-strong">{error}</p>}
          <Button type="submit" disabled={loading} className="w-full">{loading ? "Submitting…" : "Submit application"}</Button>
        </form>
        <p className="mt-4 text-sm text-text-secondary">
          Already have an account?{" "}
          <Link to="/login" className="text-accent-strong hover:underline">Sign in</Link>
        </p>
      </Card>
    </div>
  );
}
