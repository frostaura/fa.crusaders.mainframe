import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { endpoints, uploadPhoto } from "../lib/api";
import { describeFailure, isDeploymentFault } from "../lib/errors";
import { AuthShell } from "../components/AuthShell";
import { Button, Input, Label } from "../components/Button";
import { PhotoPicker } from "../components/PhotoPicker";

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
  // Already prepared by PhotoPicker at the moment it was chosen — a small, correctly-rotated
  // JPEG inside the upload cap. Nothing further to do to it here.
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  /** Set when the failure is the club's to fix, so retrying is pointless — see isDeploymentFault. */
  const [blocked, setBlocked] = useState(false);
  /** True while PhotoPicker is decoding and re-encoding — see its onBusyChange. */
  const [preparingPhoto, setPreparingPhoto] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (preparingPhoto) {
      // Distinct from having no photo at all. Telling someone who is watching their photo
      // being prepared that they have not chosen one is simply false.
      setError("Your photo is still being prepared — give it a second, then submit again.");
      return;
    }
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
      setError(describeFailure(err, { codes: MESSAGES, action: "submit your application" }));
      // A missing tenant or a 5xx is not something resubmitting can cure. Hiding the submit
      // button is the honest response: the previous screen invited the member to keep
      // pressing it against a fault only the club's operator could clear.
      setBlocked(isDeploymentFault(err));
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <AuthShell className="my-auto" subline="Your application is in.">
        <>
          <h1 className="text-lg font-semibold mb-2">Check your inbox</h1>
          <ol className="mb-5 space-y-2 text-sm text-text-secondary">
            {/*
              The three steps, because "an admin reviews your application" left an applicant with
              no idea whether anything more was required of them, or how long to wait before
              assuming it had failed.
            */}
            <li className="flex gap-2"><span aria-hidden="true">1.</span><span>We've emailed you a link — open it to confirm your address.</span></li>
            <li className="flex gap-2"><span aria-hidden="true">2.</span><span>The club checks your membership number against its records.</span></li>
            <li className="flex gap-2"><span aria-hidden="true">3.</span><span>You'll get a second email once you're approved, and then you can book.</span></li>
          </ol>
          <Button variant="outline" onClick={() => nav("/login")} className="w-full">Back to sign in</Button>
        </>
      </AuthShell>
    );
  }

  return (
    // Top-aligned, NOT centred. This card is tall, and centring it pushes the club band off the
    // top of a 360x640 viewport on load — throwing away the one thing that tells an applicant
    // whose page they are about to hand a photograph of their face to.
    <AuthShell subline="Apply for a member account. It takes a minute.">
      <>
        <h1 className="text-lg font-semibold mb-4">Join the club</h1>
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
          <PhotoPicker value={photo} onChange={setPhoto} onError={setError} onBusyChange={setPreparingPhoto} required />
          {error && (
            <p role="alert" className="rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2.5 text-sm text-danger-strong">
              {error}
            </p>
          )}
          {!blocked && (
            <Button
              type="submit"
              variant="primary"
              loading={loading || preparingPhoto}
              className="w-full"
            >
              {loading ? "Submitting…" : preparingPhoto ? "Preparing your photo…" : "Submit application"}
            </Button>
          )}
        </form>
        <p className="mt-4 text-sm text-text-secondary">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-accent-strong underline underline-offset-2 hover:no-underline">Sign in</Link>
        </p>
      </>
    </AuthShell>
  );
}
