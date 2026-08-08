import { describe, expect, it } from "vitest";
import { partitionByCitation, type SentenceVerdict, SentenceVerdictSchema } from "./classify";
import type { Sentence } from "./segment";

/**
 * The contract with the model. Everything downstream — `aggregate`'s invariant,
 * `route`'s team lookup, the quote the queue UI shows — assumes a verdict that
 * got past this schema is well-formed, so the schema is the only thing standing
 * between a malformed generation and `run.json`.
 */

const VALID: SentenceVerdict = {
  column: "q6_what_could_improve",
  sentenceIndex: 1,
  quote: "That said, put me down for next fall.",
  signal: "strong",
  engagementType: "volunteer_again",
  confidence: 0.98,
  serviceRecovery: false,
};

describe("SentenceVerdictSchema", () => {
  it("accepts a well-formed verdict", () => {
    expect(SentenceVerdictSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts a null engagement type, because the schema cannot express the union", () => {
    const result = SentenceVerdictSchema.safeParse({
      ...VALID,
      signal: "none",
      engagementType: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts the contradiction the schema is unable to reject", () => {
    // `signal: 'none'` with a type attached is well-formed *to the schema* —
    // @ai-sdk/google cannot express the discriminated union, so this arrives
    // looking valid. `aggregate` is what discards it; this test pins the reason
    // that runtime check has to exist.
    const result = SentenceVerdictSchema.safeParse({
      ...VALID,
      signal: "none",
      engagementType: "donation",
    });

    expect(result.success).toBe(true);
  });

  describe("rejects", () => {
    it("a column outside the three we read", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, column: "q4_volunteer_again" });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["column"]);
        expect(result.error.issues[0]?.code).toBe("invalid_value");
      }
    });

    it("an engagement type outside the enum", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, engagementType: "donate_swag" });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["engagementType"]);
    });

    it("a confidence above 1", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, confidence: 1.5 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["confidence"]);
        expect(result.error.issues[0]?.code).toBe("too_big");
      }
    });

    it("a confidence below 0", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, confidence: -0.1 });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.code).toBe("too_small");
    });

    it("a negative sentence index", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, sentenceIndex: -1 });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["sentenceIndex"]);
    });

    it("a fractional sentence index", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, sentenceIndex: 1.5 });

      expect(result.success).toBe(false);
    });
  });

  it("accepts the boundary confidences", () => {
    expect(SentenceVerdictSchema.safeParse({ ...VALID, confidence: 0 }).success).toBe(true);
    expect(SentenceVerdictSchema.safeParse({ ...VALID, confidence: 1 }).success).toBe(true);
  });

  it("accepts sentence index 0", () => {
    expect(SentenceVerdictSchema.safeParse({ ...VALID, sentenceIndex: 0 }).success).toBe(true);
  });
});

/**
 * The citation guard.
 *
 * Both failure directions matter and they fail differently. An **over-claim** —
 * keeping a verdict that cites a sentence we never sent — puts a real quote
 * under the wrong survey question in a staffer's queue, and the lead still
 * looks credible, so nothing downstream can catch it. An **under-claim** —
 * dropping a verdict that was fine — loses a volunteer who did express intent,
 * which is the loss this whole project exists to prevent.
 */

function sentence(overrides: Partial<Sentence> = {}): Sentence {
  return {
    responseId: "JA-1",
    column: "q5_what_went_well",
    index: 0,
    text: "The students were engaged.",
    ...overrides,
  };
}

function cite(column: SentenceVerdict["column"], sentenceIndex: number): SentenceVerdict {
  return { ...VALID, column, sentenceIndex };
}

describe("partitionByCitation", () => {
  describe("over-claim guard — must not let an unsent citation through", () => {
    it("rejects an index past the end of the column", () => {
      const sent = [sentence({ index: 0 })];

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q5_what_went_well", 1)],
        sent,
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });

    it("rejects a column the volunteer left blank", () => {
      // q6 was empty, so no q6 sentence was ever sent. A verdict citing it is
      // the planted-case failure in reverse: a quote filed under the wrong box.
      const sent = [sentence({ column: "q5_what_went_well", index: 0 })];

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q6_what_could_improve", 0)],
        sent,
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });

    it("rejects a right-index, wrong-column citation", () => {
      // The sharp case: index 0 genuinely exists — in q5, not q7. Matching on
      // the index alone would wave this through and misattribute the quote.
      const sent = [sentence({ column: "q5_what_went_well", index: 0 })];

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q7_anything_else", 0)],
        sent,
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });

    it("rejects everything when the response had no free text at all", () => {
      const { addressable, unaddressable } = partitionByCitation(
        [cite("q5_what_went_well", 0)],
        [],
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });
  });

  describe("under-claim guard — must not drop a valid verdict", () => {
    it("keeps a verdict for every sentence that was sent", () => {
      const sent = [
        sentence({ column: "q5_what_went_well", index: 0 }),
        sentence({ column: "q6_what_could_improve", index: 0 }),
        sentence({ column: "q6_what_could_improve", index: 1 }),
        sentence({ column: "q7_anything_else", index: 0 }),
      ];
      const verdicts = sent.map((s) => cite(s.column, s.index));

      const { addressable, unaddressable } = partitionByCitation(verdicts, sent);

      expect(addressable).toEqual(verdicts);
      expect(unaddressable).toEqual([]);
    });

    it("keeps index 0, which a truthiness check would silently discard", () => {
      const sent = [sentence({ index: 0 })];

      const { addressable } = partitionByCitation([cite("q5_what_went_well", 0)], sent);

      expect(addressable).toHaveLength(1);
    });

    it("keeps the good verdicts when a sibling in the same batch is dropped", () => {
      // A single hallucinated citation must not cost the response its real
      // leads — the planted q6 offer is in this batch.
      const sent = [
        sentence({ column: "q6_what_could_improve", index: 0 }),
        sentence({ column: "q6_what_could_improve", index: 1 }),
      ];
      const good = cite("q6_what_could_improve", 1);

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q6_what_could_improve", 0), cite("q7_anything_else", 4), good],
        sent,
      );

      expect(addressable).toEqual([cite("q6_what_could_improve", 0), good]);
      expect(unaddressable).toEqual([cite("q7_anything_else", 4)]);
    });

    it("keeps a high index when the column really is that long", () => {
      const sent = Array.from({ length: 12 }, (_, index) =>
        sentence({ column: "q7_anything_else", index }),
      );

      const { addressable } = partitionByCitation([cite("q7_anything_else", 11)], sent);

      expect(addressable).toHaveLength(1);
    });
  });

  it("preserves the model's ordering within each half", () => {
    const sent = [
      sentence({ column: "q5_what_went_well", index: 0 }),
      sentence({ column: "q7_anything_else", index: 0 }),
    ];

    const { addressable } = partitionByCitation(
      [cite("q7_anything_else", 0), cite("q5_what_went_well", 0)],
      sent,
    );

    expect(addressable.map((v) => v.column)).toEqual(["q7_anything_else", "q5_what_went_well"]);
  });

  it("returns two empty halves for an empty batch", () => {
    expect(partitionByCitation([], [sentence()])).toEqual({
      addressable: [],
      unaddressable: [],
    });
  });
});
