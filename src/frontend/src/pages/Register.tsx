import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { endpoints, uploadPhoto } from "../lib/api";
import { describeFailure, isDeploymentFault } from "../lib/errors";
import { AuthShell } from "../components/AuthShell";
import { Alert } from "../components/Alert";
import { Button, Input, Label } from "../components/Button";
import { PhotoPicker, type PhotoPickerHandle } from "../components/PhotoPicker";
import {
  INBOX_HEADING, INBOX_PATIENCE, INBOX_STEPS,
  PHOTO_PREPARING, PHOTO_REQUIRED, REGISTER_MESSAGES, VERIFY_BACK_TO_SIGN_IN,
} from "../lib/registrationCopy";

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
  /**
   * The form's complaint about the photo field, shown ON the field.
   *
   * <p>
   * Held apart from `error` — the page-level alert — because they are about different things
   * and, until this change, one of them could not be reached at all. `error` is what the club's
   * system said about an application that was actually sent; this is what this form noticed
   * before sending one. Putting the second in the first's banner also announced it twice, since
   * `Alert` and the picker's own message are both `role="alert"`.
   * </p>
   */
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);
  /** So a refusal can put the keyboard on the field it is about. See PhotoPickerHandle. */
  const photoField = useRef<PhotoPickerHandle>(null);

  /** Refuse, say why on the field, and take the member to it. Never silently. */
  const refusePhoto = (message: string) => {
    setPhotoProblem(message);
    photoField.current?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPhotoProblem(null);
    if (preparingPhoto) {
      refusePhoto(PHOTO_PREPARING);
      return;
    }
    if (!photo) {
      refusePhoto(PHOTO_REQUIRED);
      return;
    }
    setLoading(true);
    try {
      const upload = await uploadPhoto(photo);
      await endpoints.register({ email, password, fullName, membershipNumber, photoUrl: upload.url });
      setSubmitted(true);
    } catch (err) {
      setError(describeFailure(err, { codes: REGISTER_MESSAGES, action: "submit your application" }));
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
          <h1 className="text-lg font-semibold mb-2">{INBOX_HEADING}</h1>
          <ol className="mb-3 space-y-2 text-sm text-text-secondary">
            {/*
              The three steps, because "an admin reviews your application" left an applicant with
              no idea whether anything more was required of them, or how long to wait before
              assuming it had failed.
            */}
            {INBOX_STEPS.map((step, i) => (
              <li key={step} className="flex gap-2"><span aria-hidden="true">{i + 1}.</span><span>{step}</span></li>
            ))}
          </ol>
          {/* How long, before anybody has to ask. See INBOX_PATIENCE. */}
          <p className="mb-5 text-sm text-text-muted">{INBOX_PATIENCE}</p>
          <Button variant="outline" onClick={() => nav("/login")} className="w-full">{VERIFY_BACK_TO_SIGN_IN}</Button>
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
          <PhotoPicker
            ref={photoField}
            value={photo}
            /* Choosing one answers the complaint, so the complaint goes at that moment rather
               than surviving until the next submit. */
            onChange={(file) => { setPhoto(file); setPhotoProblem(null); }}
            error={photoProblem}
            onBusyChange={setPreparingPhoto}
            required
          />
          {error && (
            <Alert>
              {error}
            </Alert>
          )}
          {/* The one commitment on the page, and item 12's `affirm`. No `onAction`: the form's
              own handler already owns the redirect-or-explain, and its failure is the `Alert`
              above rather than a shake on the button. */}
          {!blocked && (
            <Button
              intent="affirm"
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
