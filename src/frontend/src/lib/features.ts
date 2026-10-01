/** Product switches. One constant per switch; flipping one is the whole change. */
export const FEATURES = {
  /** Court-box fingerprint enrolment in the admin console. Off until the court box reads fingerprints (P13, Dean 2026-10-01). */
  fingerprintEnrolment: false,
} as const;
