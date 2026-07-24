import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { endpoints, ApiError, uploadPhoto } from "../lib/api";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";

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
      if (err instanceof ApiError && err.status === 409) setError("An account with that email already exists.");
      else if (err instanceof ApiError && err.status === 400) setError("Please check your details — password must be at least 8 characters.");
      else setError("Registration failed. Try again.");
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
