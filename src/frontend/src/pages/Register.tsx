import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { endpoints, uploadPhoto } from "../lib/api";
import { describeFailure, isDeploymentFault } from "../lib/errors";
import { preparePhoto, PhotoError, PHOTO_MESSAGES } from "../lib/photo";
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

  // The upload endpoint's own refusals. They were absent, and that absence is what made a
  // rejected photo read as a network fault: uploadPhoto throws before register() is ever
  // called, and every code it can produce fell through to the connection sentence.
  // preparePhoto now re-encodes to a small JPEG before the request, so reaching any of these
  // means something stranger than a big iPhone photo went wrong — they stay mapped because a
  // sentence naming the real cause is the entire point of this screen.
  unsupported_content_type:
    "The club's system wouldn't accept that image format. Try a different photo — a JPEG or PNG works.",
  file_too_large: "That photo is too large for the club's system, even after resizing. Try a different one.",
  file_missing: "The photo didn't reach the club's system. Pick it again and resubmit.",
  expected_multipart: "The photo didn't upload correctly. Pick it again and resubmit.",
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
  /** Set when the failure is the club's to fix, so retrying is pointless — see isDeploymentFault. */
  const [blocked, setBlocked] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!photo) {
      setError("Please upload a photo of yourself — it's used to identify you on court.");
      return;
    }
    setLoading(true);
    try {
      // Re-encoded in the browser first: a phone's HEIC or 8MB JPEG is turned into a small,
      // correctly-rotated JPEG the API accepts. Its failures are distinct from the API's and
      // are reported as themselves.
      const prepared = await preparePhoto(photo);
      const upload = await uploadPhoto(prepared);
      await endpoints.register({ email, password, fullName, membershipNumber, photoUrl: upload.url });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof PhotoError) {
        setError(PHOTO_MESSAGES[err.problem]);
        setBlocked(false);
      } else {
        setError(describeFailure(err, {
          codes: MESSAGES,
          fallback: "We couldn't submit your application, and the club's system didn't say why. Try again — if it keeps failing, contact the club committee.",
        }));
        // A missing tenant or a 5xx is not something resubmitting can cure. Hiding the submit
        // button is the honest response: the previous screen invited the member to keep
        // pressing it against a fault only the club's operator could clear.
        setBlocked(isDeploymentFault(err));
      }
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
          {!blocked && (
            <Button type="submit" disabled={loading} className="w-full">{loading ? "Submitting…" : "Submit application"}</Button>
          )}
        </form>
        <p className="mt-4 text-sm text-text-secondary">
          Already have an account?{" "}
          <Link to="/login" className="text-accent-strong hover:underline">Sign in</Link>
        </p>
      </Card>
    </div>
  );
}
