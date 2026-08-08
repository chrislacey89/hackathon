import type { EngagementType, SentenceVerdict } from "../domain/engagement";
import { aggregate, type ResponseVerdict } from "../pipeline/aggregate";
import type { SurveyResponse } from "../pipeline/ingest";
import { segmentResponse } from "../pipeline/segment";

/**
 * The bar every model number has to clear.
 *
 * PRD #1 §SMART criteria requires the keyword baseline beside every reported
 * metric, because a metric alone cannot be attributed. "Signal recall 0.90"
 * sounds like the classifier is working; it means nothing until you know a
 * regex written in an afternoon reaches 0.86 on the same rows. Without the
 * comparison the project cannot tell a result from an artifact of easy data.
 *
 * **Every pattern below was derived from the dev split only** (issue #3
 * acceptance criteria). The holdout 50 were never read while choosing them —
 * which is the entire reason the holdout number is worth quoting. The
 * derivation script is not committed; it walked the dev rows' prose, ranked
 * n-grams by precision against the dev labels, and kept the phrases a person
 * writing this regex by hand would plausibly have reached for.
 */

/** Unambiguous commitment — the volunteer is asking to be contacted. */
const STRONG_PATTERNS = [
  /\bsign me up\b/,
  /\bput me down\b/,
  /\bput me on the list\b/,
  /\badd me to\b/,
  /\bplease call me\b/,
  /\bplease reach out\b/,
  /\bi want to\b/,
  /\bi'd like to\b/,
  /\bi would love to\b/,
  /\bcan we talk\b/,
  /\bi'll still be back\b/,
  /\bi'd gladly\b/,
  /\bi'd sign up\b/,
];

/** Hedged or conditional interest — real, but not yet an ask. */
const SOFT_PATTERNS = [
  /\bmaybe\b/,
  /\bmight\b/,
  /\bpossibly\b/,
  /\bdepends\b/,
  /\bdepending on\b/,
  /\bwould consider\b/,
  /\bi'd consider\b/,
  /\bthink about it\b/,
  /\blet me know\b/,
  /\bkeep me on\b/,
  /\breach out in\b/,
];

/**
 * Complaint language.
 *
 * These reach recall 1.00 and precision 0.37 on dev, and the imprecision is a
 * property of the labels rather than of the list: every flagged row contains
 * one of these phrases, but so do roughly three times as many unflagged rows.
 * `service_recovery_flag` is not a function of the complaint text alone, so
 * this is the widest gap on the board for the model to win — which is exactly
 * what a baseline is for.
 */
const RECOVERY_PATTERNS = [
  /\bnightmare\b/,
  /\bno one met me\b/,
  /\barrived late\b/,
  /\bnever received\b/,
  /\bwasn't prepared\b/,
  /\bfelt rushed\b/,
  /\bdid not feel supported\b/,
  /\bhad to improvise\b/,
  /\bhad to wing it\b/,
  /\bwas a struggle\b/,
];

/**
 * Type cues, matched against the whole response rather than one sentence.
 *
 * A volunteer names the *kind* of engagement in one sentence and commits in
 * another — "Is there a way to get involved beyond the classroom? I have the
 * time and I'd like to help." Per-sentence matching scores the commitment and
 * loses the type, which on dev put every committee_board row in the wrong
 * class. The signal is per sentence because it needs a quote to cite; the type
 * is per response because that is where it lives.
 *
 * Ordered: the first match wins, so the more specific cues come first.
 */
const TYPE_PATTERNS: [RegExp, EngagementType][] = [
  [/\bspeaker list\b|\bcareer day\b/, "speaking"],
  [/\bunderwrit|\bcommunity partnership\b|\bmy firm\b|\bour company\b/, "corporate_sponsorship"],
  [/\bsponsor\b|\bdonat/, "donation"],
  [/\bbeyond the classroom\b|\bcommittee\b|\bboard\b|\bget involved\b/, "committee_board"],
  [/\bbring this program\b|\bcolleague\b|\brefer\b/, "refer_colleague"],
];

/** The fallback when a response shows intent but names no particular kind. */
const DEFAULT_TYPE: EngagementType = "volunteer_again";

/**
 * Fixed, because a rate is not a confidence. The baseline has no belief about
 * any individual row — it matched a string — and a varying number here would
 * invite `aggregate`'s tiebreak to read meaning into noise.
 */
const BASELINE_CONFIDENCE = 0.5;

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Predict every response's verdict from keywords alone — no model, no network.
 *
 * Returns one verdict per input row, including the rows with nothing written
 * in them. The eval join is total, so a baseline that returned only its hits
 * would fail the join rather than quietly scoring a smaller denominator.
 *
 * Rolls up through `aggregate` rather than constructing `ResponseVerdict`
 * directly. That is not convenience: `aggregate` owns the invariant that a
 * `none` signal carries a null type, and a baseline that built its own verdicts
 * could drift from the shape the model's predictions have — at which point the
 * comparison the baseline exists for would be measuring two different things.
 */
export function keywordBaseline(rows: SurveyResponse[]): ResponseVerdict[] {
  return rows.map((response) => {
    const whole = [response.q5WhatWentWell, response.q6WhatCouldImprove, response.q7AnythingElse]
      .filter((prose): prose is string => prose !== null)
      .join(" ")
      .toLowerCase();

    const engagementType =
      TYPE_PATTERNS.find(([pattern]) => pattern.test(whole))?.[1] ?? DEFAULT_TYPE;

    const verdicts: SentenceVerdict[] = segmentResponse(response).map((sentence) => {
      const text = sentence.text.toLowerCase();
      const strong = matches(STRONG_PATTERNS, text);
      const signal = strong ? "strong" : matches(SOFT_PATTERNS, text) ? "soft" : "none";

      return {
        column: sentence.column,
        sentenceIndex: sentence.index,
        quote: sentence.text,
        signal,
        engagementType: signal === "none" ? null : engagementType,
        confidence: BASELINE_CONFIDENCE,
        serviceRecovery: matches(RECOVERY_PATTERNS, text),
        // Not judged, rather than judged-and-rejected. This baseline exists to
        // give the signal metrics a floor to beat; it has no keyword theory of
        // what makes a sentence worth quoting, and claiming `false` would put
        // 384 fabricated negatives into anything that later scored quotability.
        quotable: null,
      };
    });

    return aggregate(response.responseId, verdicts);
  });
}
