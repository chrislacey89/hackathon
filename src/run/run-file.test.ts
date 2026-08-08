import { describe, expect, it } from "vitest";
import type { ClassMetrics, EvalReport } from "../eval/evaluate";
import { parseRun, RunFileError } from "./run-file";

function classMetrics(className: string, overrides: Partial<ClassMetrics> = {}): ClassMetrics {
  return {
    className,
    tp: 1,
    fp: 0,
    fn: 0,
    precision: 1,
    recall: 1,
    support: 1,
    unmeasurable: true,
    ...overrides,
  };
}

function report(split: "dev" | "holdout"): EvalReport {
  return {
    split,
    signal: [classMetrics("strong")],
    engagementType: [classMetrics("volunteer_again")],
    serviceRecovery: classMetrics("service_recovery"),
    baseline: { signal: [classMetrics("strong")] },
    excluded: [],
    totalLabeled: 1,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-08-08T00:00:00.000Z",
    configSource: "config/teams.example.json",
    recipients: [],
    teams: [],
    partial: true,
    counts: { responses: 0, routed: 0, unowned: 0, multiIntent: 0, serviceRecovery: 0 },
    leads: [],
    eval: null,
    ...overrides,
  };
}

describe("parseRun", () => {
  it("reads a run that carries an eval report for both splits", () => {
    const parsed = parseRun(run({ eval: { dev: report("dev"), holdout: report("holdout") } }));

    expect(parsed.eval?.dev.split).toBe("dev");
    expect(parsed.eval?.holdout.totalLabeled).toBe(1);
    expect(parsed.eval?.dev.baseline.signal[0]?.className).toBe("strong");
  });

  /**
   * A run whose predictions do not cover the labeled sample carries `null`
   * rather than a partial report. The tracer classifies one response; scoring
   * it against 150 labels and publishing the result would be the confident
   * wrong number the whole harness exists to prevent.
   */
  it("reads a run that has not been scored as null rather than as zeroes", () => {
    expect(parseRun(run()).eval).toBeNull();
  });

  it("rejects a run whose eval is missing the field entirely", () => {
    const { eval: _omitted, ...withoutEval } = run();

    expect(() => parseRun(withoutEval)).toThrow(RunFileError);
  });

  // A rate arriving without its count is the one shape this project refuses to
  // publish, so the validator will not accept it off disk either.
  it("rejects class metrics that report a rate with no support", () => {
    const { support: _dropped, ...rateWithoutCount } = classMetrics("strong");
    const broken = { ...report("dev"), signal: [rateWithoutCount] };

    expect(() => parseRun(run({ eval: { dev: broken, holdout: report("holdout") } }))).toThrow(
      RunFileError,
    );
  });

  it("names the offending path when the eval does not match", () => {
    const broken = { ...report("dev"), split: "validation" };

    try {
      parseRun(run({ eval: { dev: broken, holdout: report("holdout") } }));
      throw new Error("expected the parse to fail, but it succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(RunFileError);
      expect((error as RunFileError).message).toContain("eval.dev.split");
    }
  });
});
