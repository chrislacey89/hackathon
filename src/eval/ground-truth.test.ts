import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { GroundTruthError, loadGroundTruth } from "./ground-truth";

const TRUTH_PATH = "data/ground_truth_labeled_sample.csv";

const HEADER =
  "response_id,engagement_signal,engagement_type,signal_found_in_column,service_recovery_flag";

async function csvFile(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ground-truth-"));
  const path = join(dir, "truth.csv");
  await writeFile(path, body, "utf8");
  return path;
}

describe("loadGroundTruth", () => {
  it("reads every labeled row", async () => {
    const rows = await Effect.runPromise(loadGroundTruth(TRUTH_PATH));

    expect(rows).toHaveLength(150);
  });

  it("reads a labeled signal with all five columns populated", async () => {
    const path = await csvFile(`${HEADER}\nJA-24001,soft,volunteer_again,q7_anything_else,N\n`);

    const rows = await Effect.runPromise(loadGroundTruth(path));

    expect(rows[0]).toEqual({
      responseId: "JA-24001",
      engagementSignal: "soft",
      engagementType: "volunteer_again",
      signalFoundInColumn: "q7_anything_else",
      serviceRecoveryFlag: false,
    });
  });

  it("reads the blank type and column of a none row as null, not empty string", async () => {
    const path = await csvFile(`${HEADER}\nJA-24003,none,,,Y\n`);

    const rows = await Effect.runPromise(loadGroundTruth(path));

    expect(rows[0]).toEqual({
      responseId: "JA-24003",
      engagementSignal: "none",
      engagementType: null,
      signalFoundInColumn: null,
      serviceRecoveryFlag: true,
    });
  });

  describe("refuses to degrade a label it cannot read", () => {
    async function reasonFor(body: string): Promise<string> {
      const result = await Effect.runPromise(Effect.either(loadGroundTruth(await csvFile(body))));
      if (result._tag === "Right") throw new Error("expected the load to fail, but it succeeded");
      expect(result.left).toBeInstanceOf(GroundTruthError);
      return result.left.reason;
    }

    it("fails on a missing column rather than reading it as blank", async () => {
      const reason = await reasonFor(
        "response_id,engagement_signal,engagement_type,signal_found_in_column\nJA-1,none,,\n",
      );

      expect(reason).toContain("service_recovery_flag");
    });

    // Silently becoming `none` would move the row into the majority class and
    // *raise* every reported number — a metric improving as the data degrades.
    it("fails on an unrecognised signal rather than treating it as none", async () => {
      const reason = await reasonFor(`${HEADER}\nJA-1,maybe,,,N\n`);

      expect(reason).toContain('line 2 has unrecognised engagement_signal "maybe"');
    });

    it("fails on an engagement type outside the taxonomy", async () => {
      const reason = await reasonFor(`${HEADER}\nJA-1,strong,mentoring,q7_anything_else,N\n`);

      expect(reason).toContain('line 2 has unrecognised engagement_type "mentoring"');
    });

    it("fails on a source column the pipeline never reads", async () => {
      const reason = await reasonFor(`${HEADER}\nJA-1,strong,speaking,q2_would_recommend,N\n`);

      expect(reason).toContain(
        'line 2 has unrecognised signal_found_in_column "q2_would_recommend"',
      );
    });

    // A blank flag defaulting to N would silently deny 19 complaints exist.
    it("fails on a service recovery flag that is neither Y nor N", async () => {
      const reason = await reasonFor(`${HEADER}\nJA-1,none,,,\n`);

      expect(reason).toContain('line 2 has unrecognised service_recovery_flag ""');
    });

    it("fails on a row with no response_id, naming the line to open", async () => {
      const reason = await reasonFor(`${HEADER}\nJA-1,none,,,N\n,none,,,N\n`);

      expect(reason).toContain("line 3 has no response_id");
    });
  });
});
