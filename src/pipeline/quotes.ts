import type { SurveyResponse } from "./ingest";

/**
 * What `opt_in_contact` licenses us to do with a volunteer's words.
 *
 * Three states, not two, because the export has three: 234 responses say yes,
 * 46 say no, and 104 say nothing at all. Collapsing the blanks into either
 * answer is the whole problem — treat them as yes and we attribute a grant
 * quote to someone who never agreed; treat them as no and we silently discard
 * a quarter of Karen's stated top need. `needs_check` is the honest third
 * state, and it is a question for a human rather than a verdict.
 */
export type Consent = "granted" | "needs_check" | "declined";

/**
 * Read one response's consent.
 *
 * Pure and total over all three states `ingest` can produce. `optInContact` is
 * already tri-state coming out of `ingest`, which maps anything that is not a
 * literal "yes" or "no" — a typo, a stray "Y", a value JA adds later — to
 * `null`. That means an unrecognised value lands in `needs_check` rather than
 * in `granted`, which is the direction an unknown should fall in when the cost
 * of being wrong is a consent violation.
 */
export function consentOf(response: SurveyResponse): Consent {
  if (response.optInContact === true) return "granted";
  if (response.optInContact === false) return "declined";
  return "needs_check";
}
