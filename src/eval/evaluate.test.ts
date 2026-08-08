import { describe, expect, it } from "vitest";
import type { EngagementSignal, EngagementType } from "../domain/engagement";
import type { ResponseVerdict } from "../pipeline/aggregate";
import { type ClassMetrics, EvalJoinError, evaluate, MIN_MEASURABLE_SUPPORT } from "./evaluate";
import type { GroundTruth } from "./ground-truth";

function truth(
  responseId: string,
  engagementSignal: EngagementSignal,
  overrides: Partial<GroundTruth> = {},
): GroundTruth {
  return {
    responseId,
    engagementSignal,
    engagementType: engagementSignal === "none" ? null : "volunteer_again",
    signalFoundInColumn: engagementSignal === "none" ? null : "q7_anything_else",
    serviceRecoveryFlag: false,
    ...overrides,
  };
}

function predict(
  responseId: string,
  signal: EngagementSignal,
  overrides: Partial<ResponseVerdict> = {},
): ResponseVerdict {
  const engagementType: EngagementType | null = signal === "none" ? null : "volunteer_again";
  return {
    responseId,
    signal,
    engagementType,
    engagementTypes: engagementType === null ? [] : [engagementType],
    confidence: 0.9,
    quote: signal === "none" ? null : "Put me down for next fall.",
    sourceColumn: signal === "none" ? null : "q7_anything_else",
    serviceRecovery: false,
    multiIntent: false,
    verdicts: [],
    ...overrides,
  };
}

function metricsFor(classes: ClassMetrics[], className: string): ClassMetrics {
  const found = classes.find((entry) => entry.className === className);
  if (found === undefined) throw new Error(`no metrics reported for class "${className}"`);
  return found;
}

describe("evaluate", () => {
  /**
   * Five rows, hand-scored. Predictions: A correct, B a strong called soft, C
   * correct, D correct, E a none called soft.
   *
   * strong: tp 1 (A), fp 0, fn 1 (B)      -> precision 1,   recall 0.5, support 2
   * soft:   tp 1 (C), fp 2 (B, E), fn 0   -> precision 1/3, recall 1,   support 1
   * none:   tp 1 (D), fp 0, fn 1 (E)      -> precision 1,   recall 0.5, support 2
   */
  it("returns the hand-computed numbers for a known set of predictions", () => {
    const report = evaluate({
      split: "dev",
      truth: [
        truth("A", "strong"),
        truth("B", "strong"),
        truth("C", "soft"),
        truth("D", "none"),
        truth("E", "none"),
      ],
      predictions: [
        predict("A", "strong"),
        predict("B", "soft"),
        predict("C", "soft"),
        predict("D", "none"),
        predict("E", "soft"),
      ],
      baseline: [
        predict("A", "none"),
        predict("B", "none"),
        predict("C", "none"),
        predict("D", "none"),
        predict("E", "none"),
      ],
    });

    expect(metricsFor(report.signal, "strong")).toMatchObject({
      tp: 1,
      fp: 0,
      fn: 1,
      precision: 1,
      recall: 0.5,
      support: 2,
    });
    expect(metricsFor(report.signal, "soft")).toMatchObject({
      tp: 1,
      fp: 2,
      fn: 0,
      precision: 1 / 3,
      recall: 1,
      support: 1,
    });
    expect(metricsFor(report.signal, "none")).toMatchObject({
      tp: 1,
      fp: 0,
      fn: 1,
      precision: 1,
      recall: 0.5,
      support: 2,
    });
  });

  describe("the join over the labeled set is total", () => {
    it("raises a typed error for a labeled row with no prediction, rather than skipping it", () => {
      const call = () =>
        evaluate({
          split: "dev",
          truth: [truth("A", "strong"), truth("B", "soft"), truth("C", "none")],
          predictions: [predict("A", "strong"), predict("C", "none")],
          baseline: [predict("A", "none"), predict("B", "none"), predict("C", "none")],
        });

      expect(call).toThrow(EvalJoinError);
      // Naming the count makes the shortfall legible without a debugger: the
      // silent version of this bug reports a confident number over 2 of 3 rows.
      expect(call).toThrow("1 of 3 labeled responses have no prediction");
    });

    it("names the unmatched responseIds so the gap can be traced", () => {
      try {
        evaluate({
          split: "dev",
          truth: [truth("A", "strong"), truth("B", "soft"), truth("C", "none")],
          predictions: [predict("A", "strong")],
          baseline: [predict("A", "none"), predict("B", "none"), predict("C", "none")],
        });
        throw new Error("expected the join to fail, but it succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(EvalJoinError);
        expect((error as EvalJoinError).responseIds).toEqual(["B", "C"]);
      }
    });

    it("raises when the baseline misses a row the model predicted", () => {
      const call = () =>
        evaluate({
          split: "dev",
          truth: [truth("A", "strong"), truth("B", "soft")],
          predictions: [predict("A", "strong"), predict("B", "soft")],
          baseline: [predict("A", "none")],
        });

      expect(call).toThrow(EvalJoinError);
    });

    it("raises on a duplicated label rather than letting the last one win", () => {
      const call = () =>
        evaluate({
          split: "dev",
          truth: [truth("A", "strong"), truth("A", "none")],
          predictions: [predict("A", "strong")],
          baseline: [predict("A", "none")],
        });

      expect(call).toThrow("more than one label for the same response");
    });

    it("raises on a duplicated prediction rather than letting the last one win", () => {
      const call = () =>
        evaluate({
          split: "dev",
          truth: [truth("A", "strong")],
          predictions: [predict("A", "strong"), predict("A", "none")],
          baseline: [predict("A", "none")],
        });

      expect(call).toThrow("predictions contain more than one verdict for the same response");
    });

    // The sweep scores 384 responses; only 150 carry labels. Predictions
    // outside the labeled set are the normal case, not a join failure.
    it("ignores predictions for responses the sample never labeled", () => {
      const report = evaluate({
        split: "dev",
        truth: [truth("A", "strong")],
        predictions: [predict("A", "strong"), predict("Z", "soft")],
        baseline: [predict("A", "none"), predict("Z", "none")],
      });

      expect(report.totalLabeled).toBe(1);
      expect(metricsFor(report.signal, "strong").support).toBe(1);
    });
  });

  describe("every labeled row is accounted for", () => {
    /**
     * The accounting identity behind "zero silent drops": each scored row adds
     * exactly one to exactly one signal class's support, so the supports plus
     * the exclusions must reconstruct the labeled total. A row that vanished
     * from both would break this sum and nothing else.
     */
    function accountedFor(report: { signal: ClassMetrics[]; excluded: unknown[] }): number {
      return report.signal.reduce((sum, entry) => sum + entry.support, 0) + report.excluded.length;
    }

    it("puts a contradictory label in excluded with a reason instead of scoring it", () => {
      const report = evaluate({
        split: "dev",
        truth: [
          truth("A", "strong"),
          // A signal with no type: the annotator marked intent but named none.
          truth("B", "soft", { engagementType: null }),
        ],
        predictions: [predict("A", "strong"), predict("B", "soft")],
        baseline: [predict("A", "none"), predict("B", "none")],
      });

      expect(report.excluded).toEqual([
        { responseId: "B", reason: "label has signal soft but no engagement type" },
      ]);
      expect(accountedFor(report)).toBe(report.totalLabeled);
    });

    it("excludes a none label that carries an engagement type", () => {
      const report = evaluate({
        split: "dev",
        truth: [truth("A", "none", { engagementType: "speaking" })],
        predictions: [predict("A", "none")],
        baseline: [predict("A", "none")],
      });

      expect(report.excluded).toEqual([
        { responseId: "A", reason: "label has signal none but names engagement type speaking" },
      ]);
      expect(accountedFor(report)).toBe(1);
    });

    it("keeps an excluded row out of every metrics denominator", () => {
      const report = evaluate({
        split: "dev",
        truth: [truth("A", "soft"), truth("B", "soft", { engagementType: null })],
        predictions: [predict("A", "soft"), predict("B", "soft")],
        baseline: [predict("A", "none"), predict("B", "none")],
      });

      // Two soft labels arrived; only the scorable one counts toward support.
      expect(metricsFor(report.signal, "soft").support).toBe(1);
      expect(report.totalLabeled).toBe(2);
    });

    it("accounts for every row when all of them are scorable", () => {
      const report = evaluate({
        split: "dev",
        truth: [truth("A", "strong"), truth("B", "soft"), truth("C", "none")],
        predictions: [predict("A", "strong"), predict("B", "none"), predict("C", "none")],
        baseline: [predict("A", "none"), predict("B", "none"), predict("C", "none")],
      });

      expect(report.excluded).toEqual([]);
      expect(accountedFor(report)).toBe(3);
    });
  });

  /**
   * A: flagged and caught. B: flagged and missed. C: unflagged and called a
   * complaint. D: unflagged and left alone.
   *
   * tp 1, fp 1, fn 1 -> precision 0.5, recall 0.5, support 2
   */
  it("scores service recovery as its own binary class", () => {
    const report = evaluate({
      split: "dev",
      truth: [
        truth("A", "none", { serviceRecoveryFlag: true }),
        truth("B", "none", { serviceRecoveryFlag: true }),
        truth("C", "none"),
        truth("D", "none"),
      ],
      predictions: [
        predict("A", "none", { serviceRecovery: true }),
        predict("B", "none"),
        predict("C", "none", { serviceRecovery: true }),
        predict("D", "none"),
      ],
      baseline: ["A", "B", "C", "D"].map((id) => predict(id, "none")),
    });

    expect(report.serviceRecovery).toEqual({
      className: "service_recovery",
      tp: 1,
      fp: 1,
      fn: 1,
      precision: 0.5,
      recall: 0.5,
      support: 2,
      unmeasurable: true,
      unmeasurableReason: "low-support",
    });
  });

  it("scores engagement type per class over whatever taxonomy it is handed", () => {
    const report = evaluate({
      split: "dev",
      truth: [
        truth("A", "strong", { engagementType: "speaking" }),
        truth("B", "strong", { engagementType: "speaking" }),
        truth("C", "soft", { engagementType: "donation" }),
      ],
      predictions: [
        predict("A", "strong", { engagementType: "speaking" }),
        predict("B", "strong", { engagementType: "donation" }),
        predict("C", "soft", { engagementType: "donation" }),
      ],
      baseline: ["A", "B", "C"].map((id) => predict(id, "none")),
    });

    expect(metricsFor(report.engagementType, "speaking")).toMatchObject({
      tp: 1,
      fp: 0,
      fn: 1,
      support: 2,
    });
    expect(metricsFor(report.engagementType, "donation")).toMatchObject({
      tp: 1,
      fp: 1,
      fn: 0,
      support: 1,
    });
  });

  // Both sides say "no type", so the row is a true negative for every class and
  // belongs in no one-vs-rest denominator. `signal` is where it is counted.
  it("leaves a typeless row out of the engagement type denominators", () => {
    const report = evaluate({
      split: "dev",
      truth: [truth("A", "none"), truth("B", "strong", { engagementType: "speaking" })],
      predictions: [predict("A", "none"), predict("B", "strong", { engagementType: "speaking" })],
      baseline: [predict("A", "none"), predict("B", "none")],
    });

    expect(report.engagementType.map((entry) => entry.className)).toEqual(["speaking"]);
    expect(metricsFor(report.engagementType, "speaking").support).toBe(1);
  });

  // PRD #1 §Error Modes: without this the model number cannot be attributed —
  // a regex scoring nearly as well means the model is not what is working.
  it("reports the keyword baseline beside the model on the same classes", () => {
    const report = evaluate({
      split: "holdout",
      truth: [truth("A", "strong"), truth("B", "none")],
      predictions: [predict("A", "strong"), predict("B", "none")],
      // The baseline gets A wrong where the model got it right.
      baseline: [predict("A", "none"), predict("B", "none")],
    });

    expect(metricsFor(report.signal, "strong").recall).toBe(1);
    expect(metricsFor(report.baseline.signal, "strong").recall).toBe(0);
    expect(report.split).toBe("holdout");
  });

  describe("marks a rate the support cannot carry", () => {
    function report(strongCount: number) {
      const rows = Array.from({ length: strongCount }, (_, i) => truth(`S${i}`, "strong"));
      return evaluate({
        split: "dev",
        truth: rows,
        predictions: rows.map((row) => predict(row.responseId, "strong")),
        baseline: rows.map((row) => predict(row.responseId, "none")),
      });
    }

    it("flags a class whose support is below the measurable floor", () => {
      expect(metricsFor(report(4).signal, "strong")).toMatchObject({
        support: 4,
        recall: 1,
        unmeasurable: true,
        unmeasurableReason: "low-support",
      });
    });

    it("does not flag a class with enough labeled examples to mean something", () => {
      expect(metricsFor(report(MIN_MEASURABLE_SUPPORT).signal, "strong")).toMatchObject({
        support: MIN_MEASURABLE_SUPPORT,
        unmeasurable: false,
        unmeasurableReason: null,
      });
    });
  });
});

/**
 * The taxonomy the labels use and the taxonomy the model predicts are now
 * different schemes.
 *
 * `LABELED_SAMPLE_TYPES` is what the 150 rows were labeled with;
 * `config/categories.json` is JA's, and it shares no member with them (#24 §2 —
 * SWAG is added, volunteering splits by programme, and `speaking`,
 * `refer_colleague`, and `committee_board` are gone). Per-type precision and
 * recall across that boundary are not low, they are meaningless: every pair
 * mismatches by construction.
 *
 * The danger is specific. `unmeasurable` was purely a support threshold, so a
 * label class with 20 examples and zero possible true positives would have been
 * reported as `recall 0.00, n 20` with no flag — a confident wrong number, and
 * exactly the failure PRD #1 §Rabbit Holes drops per-type accuracy to avoid.
 */
describe("evaluate across a taxonomy change", () => {
  const rows = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

  const truthRows = rows.map((id) => truth(id, "strong", { engagementType: "speaking" }));
  const jaRows = rows.map((id) =>
    predict(id, "strong", {
      engagementType: "volunteer_jafp",
      engagementTypes: ["volunteer_jafp"],
    }),
  );

  it("marks every per-type metric unmeasurable when the two schemes are disjoint", () => {
    const report = evaluate({
      split: "dev",
      truth: truthRows,
      predictions: jaRows,
      baseline: jaRows,
    });

    // Support is 12 — well past MIN_MEASURABLE_SUPPORT — so the old threshold
    // alone would have called this measurable and printed recall 0.00.
    expect(metricsFor(report.engagementType, "speaking").support).toBeGreaterThan(
      MIN_MEASURABLE_SUPPORT,
    );
    expect(report.engagementType.every((m) => m.unmeasurable)).toBe(true);
    expect(report.engagementType.every((m) => m.unmeasurableReason === "taxonomy-mismatch")).toBe(
      true,
    );
  });

  it("leaves signal measurable — it is the taxonomy-independent number", () => {
    const report = evaluate({
      split: "dev",
      truth: truthRows,
      predictions: jaRows,
      baseline: jaRows,
    });

    // This is the whole reason PRD #1 leans on signal-vs-none: it survives the
    // taxonomy change untouched. If this ever goes unmeasurable, the harness
    // has stopped reporting the only number it is entitled to.
    expect(metricsFor(report.signal, "strong").unmeasurable).toBe(false);
    expect(metricsFor(report.signal, "strong").recall).toBe(1);
  });

  it("keeps reporting per-type numbers while the schemes still overlap", () => {
    // One shared member is enough to make the comparison meaningful again —
    // the flag must not fire merely because some class appears on one side.
    const mixed = jaRows.map((row, index) =>
      index < 6 ? { ...row, engagementType: "speaking", engagementTypes: ["speaking"] } : row,
    );

    const report = evaluate({
      split: "dev",
      truth: truthRows,
      predictions: mixed,
      baseline: mixed,
    });

    expect(metricsFor(report.engagementType, "speaking").unmeasurable).toBe(false);
    expect(metricsFor(report.engagementType, "speaking").unmeasurableReason).toBeNull();
    // A class only the model emits is still reported, with its false positives
    // counted — the case a fixed class list would hide.
    expect(metricsFor(report.engagementType, "volunteer_jafp").fp).toBe(6);
  });

  it("does not fire on an empty comparison, where there is nothing to be disjoint from", () => {
    const noneRows = rows.map((id) => truth(id, "none"));
    const nonePredictions = rows.map((id) => predict(id, "none"));

    const report = evaluate({
      split: "dev",
      truth: noneRows,
      predictions: nonePredictions,
      baseline: nonePredictions,
    });

    // Nobody named a type, so there is no taxonomy to mismatch. Reporting an
    // empty list is right; reporting it as "taxonomy-mismatch" would invent a
    // finding.
    expect(report.engagementType).toEqual([]);
  });
});
