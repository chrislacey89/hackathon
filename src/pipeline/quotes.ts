import type { FreeTextColumn } from "../domain/engagement";
import type { ResponseVerdict } from "./aggregate";
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

/**
 * One quotable sentence, with everything needed to attribute it.
 *
 * Shape locked in PRD #1 §Implementation Decisions. `consent` is the two-state
 * narrowing of `Consent`: `declined` cannot appear here, because a declined
 * response never produces a candidate at all (PRD #1 §No-gos — no quote used
 * from a volunteer who declined contact). The type says so, so a downstream
 * consumer cannot write a branch for a case that does not exist.
 */
export type QuoteCandidate = {
  responseId: string;
  quote: string;
  sourceColumn: FreeTextColumn;
  volunteerName: string;
  program: string;
  consent: Exclude<Consent, "declined">;
};

/**
 * Collect every quotable sentence the model found, minus everyone who said no.
 *
 * Two inputs rather than one because the judgement and the attribution live in
 * different places: quotability is on the sentence verdicts, and the
 * volunteer's name and program are on the survey row. Neither type carries the
 * other's half.
 *
 * Reads `verdicts`, never `signal`. A response whose signal is `none` is not a
 * lead, and this stream does not care — it is a library, not a handoff, and
 * the best line in the export may well come from someone with no intention of
 * coming back.
 */
export function extractQuotes(
  rows: SurveyResponse[],
  verdicts: ResponseVerdict[],
): QuoteCandidate[] {
  const byId = new Map(rows.map((row) => [row.responseId, row]));
  const candidates: QuoteCandidate[] = [];

  for (const verdict of verdicts) {
    const row = byId.get(verdict.responseId);
    if (row === undefined) {
      throw new Error(
        `${verdict.responseId} has a verdict but no survey row; a quote cannot be attributed`,
      );
    }

    const consent = consentOf(row);
    if (consent === "declined") continue;

    for (const sentence of verdict.verdicts) {
      if (sentence.quotable !== true) continue;
      candidates.push({
        responseId: verdict.responseId,
        quote: sentence.quote,
        sourceColumn: sentence.column,
        volunteerName: row.volunteerName,
        program: row.program,
        consent,
      });
    }
  }

  return candidates;
}
