import { describe, expect, it } from "vitest";
import { type SentenceVerdict, SentenceVerdictSchema } from "./classify";

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
