import { describe, expect, it } from "vitest";
import type { GroundTruth } from "./ground-truth";
import { splitLabeled } from "./split";

function truth(responseId: string, overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    responseId,
    engagementSignal: "none",
    engagementType: null,
    signalFoundInColumn: null,
    serviceRecoveryFlag: false,
    ...overrides,
  };
}

/** 105 none / 23 soft / 22 strong — the shape of the real labeled sample. */
function labeledSample(): GroundTruth[] {
  const rows: GroundTruth[] = [];
  for (let i = 0; i < 105; i++) rows.push(truth(`JA-${25000 + i}`));
  for (let i = 0; i < 23; i++) {
    rows.push(
      truth(`JA-${26000 + i}`, {
        engagementSignal: "soft",
        engagementType: "volunteer_again",
        signalFoundInColumn: "q7_anything_else",
      }),
    );
  }
  for (let i = 0; i < 22; i++) {
    rows.push(
      truth(`JA-${27000 + i}`, {
        engagementSignal: "strong",
        engagementType: "speaking",
        signalFoundInColumn: "q7_anything_else",
      }),
    );
  }
  return rows;
}

describe("splitLabeled", () => {
  it("splits the 150-row labeled sample into exactly 100 dev and 50 holdout", () => {
    const { dev, holdout } = splitLabeled(labeledSample());

    expect(dev).toHaveLength(100);
    expect(holdout).toHaveLength(50);
  });

  it("places every labeled row in exactly one of the two splits", () => {
    const rows = labeledSample();
    const { dev, holdout } = splitLabeled(rows);

    const placed = [...dev, ...holdout].map((row) => row.responseId).sort();
    const expected = rows.map((row) => row.responseId).sort();

    expect(placed).toEqual(expected);
  });

  it("returns the same split every time it is called", () => {
    const rows = labeledSample();

    const first = splitLabeled(rows);
    const second = splitLabeled(rows);

    expect(second.holdout.map((row) => row.responseId)).toEqual(
      first.holdout.map((row) => row.responseId),
    );
  });

  it("does not depend on the order rows arrived in", () => {
    const rows = labeledSample();
    // Reversing is enough to break any rule that reads input position: a
    // re-exported CSV with a different sort must not move rows across the
    // holdout boundary, or the reported number stops being comparable to the
    // last one.
    const reversed = [...rows].reverse();

    const fromOriginal = splitLabeled(rows)
      .holdout.map((row) => row.responseId)
      .sort();
    const fromReversed = splitLabeled(reversed)
      .holdout.map((row) => row.responseId)
      .sort();

    expect(fromReversed).toEqual(fromOriginal);
  });

  it("keeps each signal class proportionally represented in both splits", () => {
    const { dev, holdout } = splitLabeled(labeledSample());
    const count = (rows: GroundTruth[], signal: string) =>
      rows.filter((row) => row.engagementSignal === signal).length;

    // 105 / 23 / 22 split two-thirds / one-third, class by class.
    expect(count(dev, "none")).toBe(70);
    expect(count(holdout, "none")).toBe(35);
    expect(count(dev, "soft")).toBe(15);
    expect(count(holdout, "soft")).toBe(8);
    expect(count(dev, "strong")).toBe(15);
    expect(count(holdout, "strong")).toBe(7);
  });

  it("returns two empty splits for an empty labeled set", () => {
    expect(splitLabeled([])).toEqual({ dev: [], holdout: [] });
  });
});
