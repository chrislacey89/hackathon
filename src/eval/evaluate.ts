import type { ResponseVerdict } from "../pipeline/aggregate";
import type { GroundTruth } from "./ground-truth";

export type EvalSplit = "dev" | "holdout";

/**
 * One class's confusion counts and the two rates derived from them.
 *
 * The counts are not diagnostic detail beside the rates — they are the reason
 * the rates can be read at all. A recall of 0.50 means something very
 * different at a support of 2 than at a support of 105, and the difference is
 * invisible unless both travel together. PRD #1 §SMART criteria states it as a
 * requirement: no rate without its count.
 */
export type ClassMetrics = {
  className: string;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  support: number;
  /**
   * True when the rates above cannot be read as a property of the classifier.
   *
   * PRD #1 §Rabbit Holes drops per-type accuracy as unmeasurable and requires
   * it not be "quietly reported as if real". Reporting the numbers with this
   * flag attached is how that requirement is met structurally: a consumer of
   * `run.json` cannot read the rate without also reading the disclaimer, which
   * a doc comment could not guarantee.
   */
  unmeasurable: boolean;
  /**
   * Why, or `null` when the metric is readable.
   *
   * The two reasons fail differently and need different responses, so
   * collapsing them into one boolean would print the wrong explanation for
   * half the cases. `low-support` means gather more labels; `taxonomy-mismatch`
   * means no number of labels in *this* scheme will help, because the label
   * vocabulary and the prediction vocabulary are answering different questions.
   */
  unmeasurableReason: "low-support" | "taxonomy-mismatch" | null;
};

/**
 * Below this many labeled examples, one row moves recall by ten points or
 * more, so the second decimal place of a rate is describing a single
 * annotator's judgement rather than a property of the classifier.
 */
export const MIN_MEASURABLE_SUPPORT = 10;

export type EvalReport = {
  split: EvalSplit;
  /** Per `EngagementSignal` — the taxonomy-independent measure PRD #1 relies on. */
  signal: ClassMetrics[];
  engagementType: ClassMetrics[];
  serviceRecovery: ClassMetrics;
  /** Keyword-only, same shape. Reported on every run so a model number can be attributed. */
  baseline: { signal: ClassMetrics[] };
  excluded: { responseId: string; reason: string }[];
  totalLabeled: number;
};

export type EvalInput = {
  split: EvalSplit;
  predictions: ResponseVerdict[];
  /** Keyword-only predictions over the same responses — `keywordBaseline(rows)`. */
  baseline: ResponseVerdict[];
  truth: GroundTruth[];
};

/**
 * The join over the labeled set failed.
 *
 * PRD #1 §Implementation Decisions names this the harness's one invariant: an
 * unmatched labeled row is an error, never a skip. Skipping would shrink the
 * denominator silently, and a denominator nobody checked is how a harness ends
 * up reporting a confident number about a set it never scored.
 */
export class EvalJoinError extends Error {
  readonly reason: string;
  readonly responseIds: readonly string[];

  constructor(reason: string, responseIds: readonly string[]) {
    // The ids are in the message, not just on the field, because this error is
    // read from a terminal far more often than from a debugger. Capped because
    // a whole-set mismatch would otherwise print 150 ids and bury the reason.
    const shown = responseIds.slice(0, 10).join(", ");
    const rest = responseIds.length > 10 ? `, and ${responseIds.length - 10} more` : "";
    super(`${reason} — ${shown}${rest}`);
    this.name = "EvalJoinError";
    this.reason = reason;
    this.responseIds = responseIds;
  }
}

/**
 * Why a label cannot be scored, or `null` when it can.
 *
 * The prediction side cannot produce these shapes — `aggregate` enforces
 * `signal === 'none'` ⟺ `engagementType === null` and discards anything else.
 * The label side has no such guard, because it is typed straight off a CSV a
 * human filled in. Scoring a contradiction would mean picking which half of it
 * to believe; dropping it silently would shrink the denominator. Naming it and
 * standing it beside the metrics is the only option that loses nothing.
 */
function unscorableReason(row: GroundTruth): string | null {
  if (row.engagementSignal === "none" && row.engagementType !== null) {
    return `label has signal none but names engagement type ${row.engagementType}`;
  }
  if (row.engagementSignal !== "none" && row.engagementType === null) {
    return `label has signal ${row.engagementSignal} but no engagement type`;
  }
  return null;
}

/** 0/0 is reported as 0 rather than 1; `support` and the counts carry the real story. */
function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function metrics(className: string, tp: number, fp: number, fn: number): ClassMetrics {
  const support = tp + fn;
  const lowSupport = support < MIN_MEASURABLE_SUPPORT;
  return {
    className,
    tp,
    fp,
    fn,
    precision: rate(tp, tp + fp),
    recall: rate(tp, support),
    support,
    unmeasurable: lowSupport,
    unmeasurableReason: lowSupport ? "low-support" : null,
  };
}

type Pair = { actual: string | null; predicted: string | null };

/**
 * One-vs-rest confusion counts over every class either side named.
 *
 * The class list is taken from the data rather than from an enum, which keeps
 * the harness taxonomy-agnostic: it scores whatever scheme it is handed. A
 * class the model invented and the labels never use still appears, with a
 * support of 0 and its false positives counted — which is exactly the case a
 * fixed class list would hide.
 */
function perClass(pairs: Pair[]): ClassMetrics[] {
  const classNames = new Set<string>();
  for (const { actual, predicted } of pairs) {
    if (actual !== null) classNames.add(actual);
    if (predicted !== null) classNames.add(predicted);
  }

  return [...classNames].sort().map((className) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { actual, predicted } of pairs) {
      if (predicted === className && actual === className) tp++;
      else if (predicted === className) fp++;
      else if (actual === className) fn++;
    }
    return metrics(className, tp, fp, fn);
  });
}

/**
 * True when the labels and the predictions share no class at all.
 *
 * Not a low-support problem and not fixable by labelling more rows: it means
 * the two sides are using different vocabularies, so every pair mismatches by
 * construction and every rate is 0 for a reason that has nothing to do with the
 * classifier. This is the state the project is in — the sample was labeled with
 * the six types `LABELED_SAMPLE_TYPES` pins, and JA's categories share none of
 * them (#24 §2). Re-labelling against JA's taxonomy is #10's cost to pay.
 *
 * Deliberately *disjoint*, not "some class appears on one side only". A class
 * the model invented and the labels never use is a real finding with real false
 * positives, and `perClass` reports it on purpose; suppressing per-type metrics
 * the moment one such class appeared would hide it.
 *
 * An empty comparison — nobody named a type — is not disjoint. There is no
 * taxonomy to mismatch, and flagging it would invent a finding.
 */
function taxonomiesDisjoint(pairs: Pair[]): boolean {
  const actual = new Set(pairs.map((pair) => pair.actual).filter((name) => name !== null));
  const predicted = new Set(pairs.map((pair) => pair.predicted).filter((name) => name !== null));

  if (actual.size === 0 || predicted.size === 0) return false;
  return [...predicted].every((name) => !actual.has(name));
}

function indexById(verdicts: ResponseVerdict[], label: string): Map<string, ResponseVerdict> {
  const byId = new Map<string, ResponseVerdict>();
  const duplicates: string[] = [];
  for (const verdict of verdicts) {
    if (byId.has(verdict.responseId)) duplicates.push(verdict.responseId);
    byId.set(verdict.responseId, verdict);
  }
  if (duplicates.length > 0) {
    throw new EvalJoinError(
      `${label} contain more than one verdict for the same response`,
      [...new Set(duplicates)].sort(),
    );
  }
  return byId;
}

/**
 * Score predictions against the labeled sample.
 *
 * Pure and total over its declared input: no filesystem, no network, no clock.
 * The one way it does not return is the join failure above, which is the
 * behaviour PRD #1 asks for by name.
 *
 * Widened from the `evaluate(preds, truth)` declared in issue #3's boundary
 * map. Neither `split` nor `baseline` is derivable from those two arguments —
 * `baseline` needs `SurveyResponse[]`, which the signature never sees — so the
 * declared form could not construct its own return type. See
 * `docs/solutions/patterns/boundary-map-signatures-must-be-type-reachable`.
 */
export function evaluate(input: EvalInput): EvalReport {
  const { split, predictions, baseline, truth } = input;

  const predicted = indexById(predictions, "predictions");
  const baselinePredicted = indexById(baseline, "baseline predictions");

  const seen = new Set<string>();
  const duplicateLabels: string[] = [];
  for (const row of truth) {
    if (seen.has(row.responseId)) duplicateLabels.push(row.responseId);
    seen.add(row.responseId);
  }
  if (duplicateLabels.length > 0) {
    throw new EvalJoinError(
      "the labeled set contains more than one label for the same response",
      [...new Set(duplicateLabels)].sort(),
    );
  }

  const missing = truth
    .filter((row) => !predicted.has(row.responseId) || !baselinePredicted.has(row.responseId))
    .map((row) => row.responseId);
  if (missing.length > 0) {
    throw new EvalJoinError(
      `${missing.length} of ${truth.length} labeled responses have no prediction`,
      missing.sort(),
    );
  }

  const signalPairs: Pair[] = [];
  const typePairs: Pair[] = [];
  const baselineSignalPairs: Pair[] = [];
  const excluded: { responseId: string; reason: string }[] = [];
  let recoveryTp = 0;
  let recoveryFp = 0;
  let recoveryFn = 0;

  for (const row of truth) {
    const unscorable = unscorableReason(row);
    if (unscorable !== null) {
      excluded.push({ responseId: row.responseId, reason: unscorable });
      continue;
    }

    // Non-null by construction: `missing` above is empty, so every labeled id
    // is present in both maps.
    const model = predicted.get(row.responseId) as ResponseVerdict;
    const keyword = baselinePredicted.get(row.responseId) as ResponseVerdict;

    signalPairs.push({ actual: row.engagementSignal, predicted: model.signal });
    baselineSignalPairs.push({ actual: row.engagementSignal, predicted: keyword.signal });
    typePairs.push({ actual: row.engagementType, predicted: model.engagementType });

    if (model.serviceRecovery && row.serviceRecoveryFlag) recoveryTp++;
    else if (model.serviceRecovery) recoveryFp++;
    else if (row.serviceRecoveryFlag) recoveryFn++;
  }

  // Only the per-type metrics are touched. Signal is taxonomy-independent by
  // construction — strong / soft / none survive any category scheme — and it is
  // the number PRD #1 actually leans on.
  const typeMetrics = perClass(typePairs);
  const mismatched = taxonomiesDisjoint(typePairs);

  return {
    split,
    signal: perClass(signalPairs),
    engagementType: mismatched
      ? typeMetrics.map((entry) => ({
          ...entry,
          unmeasurable: true,
          unmeasurableReason: "taxonomy-mismatch" as const,
        }))
      : typeMetrics,
    serviceRecovery: metrics("service_recovery", recoveryTp, recoveryFp, recoveryFn),
    baseline: { signal: perClass(baselineSignalPairs) },
    excluded,
    totalLabeled: truth.length,
  };
}
