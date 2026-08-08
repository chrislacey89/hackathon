import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { loadResponses } from "../pipeline/ingest";
import { keywordBaseline } from "./baseline";
import { type ClassMetrics, type EvalReport, evaluate } from "./evaluate";
import { loadGroundTruth } from "./ground-truth";
import { splitLabeled } from "./split";

/**
 * The harness end to end, on the real 150 labeled rows, with no model call.
 *
 * The unit tests prove each piece computes what it claims. This proves the
 * pieces compose over the actual data — and pins the baseline's numbers, which
 * is what makes the "derived from the dev split only" claim checkable rather
 * than merely asserted: tuning the keyword list against the holdout would move
 * the dev counts below and fail here, loudly, in the same commit that did it.
 *
 * Counts rather than rounded rates. `tp 13 fp 0 fn 2` is exact and survives
 * any change to how a rate is displayed; `0.87` is neither.
 */
describe("the eval harness over the labeled sample", () => {
  let dev: EvalReport;
  let holdout: EvalReport;

  beforeAll(async () => {
    const truth = await Effect.runPromise(loadGroundTruth("data/ground_truth_labeled_sample.csv"));
    const responses = await Effect.runPromise(loadResponses("data/volunteer_survey_export.csv"));

    const predictions = keywordBaseline(responses);
    const split = splitLabeled(truth);

    dev = evaluate({ split: "dev", truth: split.dev, predictions, baseline: predictions });
    holdout = evaluate({
      split: "holdout",
      truth: split.holdout,
      predictions,
      baseline: predictions,
    });
  });

  function signal(report: EvalReport, className: string): ClassMetrics {
    const found = report.signal.find((entry) => entry.className === className);
    if (found === undefined) throw new Error(`no metrics for "${className}"`);
    return found;
  }

  it("scores all 150 labeled rows across the two splits, dropping none", () => {
    expect(dev.totalLabeled).toBe(100);
    expect(holdout.totalLabeled).toBe(50);

    for (const report of [dev, holdout]) {
      const scored = report.signal.reduce((sum, entry) => sum + entry.support, 0);
      expect(scored + report.excluded.length).toBe(report.totalLabeled);
    }
  });

  it("finds every label in the sample scorable", () => {
    expect(dev.excluded).toEqual([]);
    expect(holdout.excluded).toEqual([]);
  });

  it("reports the keyword baseline's dev numbers", () => {
    expect(signal(dev, "none")).toMatchObject({ tp: 70, fp: 0, fn: 0, support: 70 });
    expect(signal(dev, "soft")).toMatchObject({ tp: 15, fp: 2, fn: 0, support: 15 });
    expect(signal(dev, "strong")).toMatchObject({ tp: 13, fp: 0, fn: 2, support: 15 });
    expect(dev.serviceRecovery).toMatchObject({ tp: 14, fp: 24, fn: 0, support: 14 });
  });

  it("reports the keyword baseline's holdout numbers", () => {
    expect(signal(holdout, "none")).toMatchObject({ tp: 35, fp: 0, fn: 0, support: 35 });
    expect(signal(holdout, "soft")).toMatchObject({ tp: 8, fp: 1, fn: 0, support: 8 });
    expect(signal(holdout, "strong")).toMatchObject({ tp: 6, fp: 0, fn: 1, support: 7 });
    expect(holdout.serviceRecovery).toMatchObject({ tp: 5, fp: 18, fn: 0, support: 5 });
  });

  /**
   * The headline finding, and the reason PRD #1 requires the baseline beside
   * every model number: on this sample a regex reaches 0.87 recall on `strong`
   * and perfect precision. A model scoring 0.90 here has demonstrated almost
   * nothing. The data is synthetic and templated, and the baseline is what
   * makes that visible instead of flattering.
   */
  it("shows the bar a model has to clear on signal detection", () => {
    expect(signal(holdout, "strong").precision).toBe(1);
    expect(signal(holdout, "strong").recall).toBeCloseTo(6 / 7, 5);
    expect(signal(holdout, "soft").recall).toBe(1);
  });

  /**
   * And the gap worth winning. Every flagged row contains a complaint phrase,
   * but so do three times as many unflagged rows — `service_recovery_flag` is
   * not a function of the complaint text, so this is where a model can show it
   * is doing something a regex cannot.
   */
  it("shows service recovery as the gap keywords cannot close", () => {
    expect(dev.serviceRecovery.recall).toBe(1);
    expect(dev.serviceRecovery.precision).toBeLessThan(0.4);
  });

  // 22 strong and 23 soft over the whole sample means the holdout carries 7
  // and 8. One row moves recall by 12 points, so the rates are directional.
  it("marks the holdout's small classes as unmeasurable", () => {
    expect(signal(holdout, "strong").unmeasurable).toBe(true);
    expect(signal(holdout, "soft").unmeasurable).toBe(true);
    expect(signal(holdout, "none").unmeasurable).toBe(false);
  });
});
