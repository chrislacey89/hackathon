import type { EngagementSignal, EngagementType, FreeTextColumn } from "../domain/engagement";

/**
 * One row of `data/ground_truth_labeled_sample.csv` — a human's judgement about
 * one survey response, and the only thing in this project entitled to be called
 * correct.
 *
 * `engagementType` and `signalFoundInColumn` are `null` exactly when
 * `engagementSignal` is `none`, mirroring the invariant `aggregate` enforces on
 * the prediction side. The labels satisfy it in all 150 rows today; `evaluate`
 * does not assume it, because a label that violates it is unscorable rather
 * than merely surprising, and the harness has to say so out loud.
 */
export type GroundTruth = {
  responseId: string;
  engagementSignal: EngagementSignal;
  engagementType: EngagementType | null;
  signalFoundInColumn: FreeTextColumn | null;
  serviceRecoveryFlag: boolean;
};
