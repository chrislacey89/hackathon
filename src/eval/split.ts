import type { GroundTruth } from "./ground-truth";

export type LabeledSplit = {
  dev: GroundTruth[];
  holdout: GroundTruth[];
};

/** One third of the labeled set is held out — 50 of 150 (PRD #1 choice 16c). */
const HOLDOUT_FRACTION = 1 / 3;

/**
 * Partition the labeled sample into a dev set to tune against and a holdout set
 * to report.
 *
 * Deterministic by construction rather than by seed. A seeded PRNG is only
 * reproducible for as long as that exact generator is in the build; a rule
 * stated over sorted `responseId`s reproduces in any language, in any runtime,
 * years later, and can be checked by hand against the CSV. The holdout number
 * is the one figure this project asks anyone to believe, so how it was chosen
 * should be re-derivable without running this code.
 *
 * Stratified by `engagementSignal`, because the interesting classes are the
 * small ones: `strong` is 22 of 150, and an unstratified third could hand the
 * holdout six of them. Per-class recall on a support of six is noise reported
 * to two decimal places — precisely the artifact the baseline and the support
 * counts exist to expose.
 */
export function splitLabeled(truth: GroundTruth[]): LabeledSplit {
  const strata = new Map<string, GroundTruth[]>();
  for (const row of truth) {
    const stratum = strata.get(row.engagementSignal);
    if (stratum === undefined) strata.set(row.engagementSignal, [row]);
    else stratum.push(row);
  }

  const dev: GroundTruth[] = [];
  const holdout: GroundTruth[] = [];

  for (const stratum of strata.values()) {
    const sorted = [...stratum].sort((a, b) => a.responseId.localeCompare(b.responseId));
    const quota = Math.round(sorted.length * HOLDOUT_FRACTION);

    // Evenly spaced picks across the sorted stratum rather than its first or
    // last `quota` rows: `responseId` tracks submission order, so a contiguous
    // slice would hand the holdout one end of the survey window.
    const held = new Set<number>();
    for (let i = 0; i < quota; i++) held.add(Math.floor((i * sorted.length) / quota));

    sorted.forEach((row, index) => {
      if (held.has(index)) holdout.push(row);
      else dev.push(row);
    });
  }

  return { dev, holdout };
}
