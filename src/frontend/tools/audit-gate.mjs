// The CI security gate: `npm audit` at high severity, with a short list of advisories accepted on
// purpose. Each accepted entry names why and expires; an expired entry fails the gate again, so an
// exception is a decision that has to be re-made, never a hole that stays open. Anything high or
// critical that is not on the list fails exactly as `npm audit --audit-level=high` did.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const accepted = JSON.parse(readFileSync(new URL("../audit-accepted.json", import.meta.url), "utf8"));
const today = new Date().toISOString().slice(0, 10);

let raw;
try {
  raw = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  raw = error.stdout; // npm audit exits non-zero whenever it finds anything
}
const report = JSON.parse(raw);

const failures = [];
const used = new Set();
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== "high" && vuln.severity !== "critical") continue;
  // A package flagged only because it depends on another flagged package carries no advisory of
  // its own; it is cleared exactly when the package it points at is.
  const advisories = vuln.via.filter((v) => typeof v === "object");
  const blocking = advisories.filter((v) => {
    const id = v.url?.split("/").pop();
    const entry = id ? accepted[id] : undefined;
    if (!entry) return true;
    used.add(id);
    return entry.until < today;
  });
  if (blocking.length > 0) failures.push(`${name}: ${blocking.map((v) => `${v.title} (${v.url})`).join("; ")}`);
}

for (const [id, entry] of Object.entries(accepted)) {
  if (entry.until < today) failures.push(`accepted advisory ${id} expired on ${entry.until} — decide again: ${entry.why}`);
  else if (used.has(id)) console.log(`accepted until ${entry.until}: ${id} — ${entry.why}`);
}

if (failures.length > 0) {
  console.error(`npm audit gate: ${failures.length} blocking finding(s)\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("npm audit gate: nothing high or critical outside the accepted list");
