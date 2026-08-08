import { describe, expect, it } from "vitest";
import { aggregate } from "./aggregate";
import type { SentenceVerdict } from "./classify";

function verdict(overrides: Partial<SentenceVerdict> = {}): SentenceVerdict {
  return {
    column: "q7_anything_else",
    sentenceIndex: 0,
    quote: "Thanks for everything.",
    signal: "none",
    engagementType: null,
    confidence: 0.9,
    serviceRecovery: false,
    ...overrides,
  };
}

describe("aggregate", () => {
  it("reports none for a response with no verdicts at all", () => {
    const result = aggregate("JA-1", []);

    expect(result.signal).toBe("none");
    expect(result.engagementType).toBeNull();
    expect(result.engagementTypes).toEqual([]);
    expect(result.quote).toBeNull();
    expect(result.sourceColumn).toBeNull();
  });

  it("takes the strongest sentence as the response's signal", () => {
    const result = aggregate("JA-1", [
      verdict({ signal: "none" }),
      verdict({ signal: "soft", engagementType: "volunteer_again", sentenceIndex: 1 }),
      verdict({ signal: "strong", engagementType: "speaking", sentenceIndex: 2 }),
    ]);

    expect(result.signal).toBe("strong");
    expect(result.engagementType).toBe("speaking");
  });

  it("carries the triggering sentence's quote and source column", () => {
    const result = aggregate("JA-1", [
      verdict({ column: "q5_what_went_well", quote: "The students were engaged." }),
      verdict({
        column: "q6_what_could_improve",
        sentenceIndex: 1,
        quote: "That said, put me down for next fall.",
        signal: "strong",
        engagementType: "volunteer_again",
      }),
    ]);

    expect(result.quote).toBe("That said, put me down for next fall.");
    expect(result.sourceColumn).toBe("q6_what_could_improve");
  });

  it("breaks a tie between equally strong sentences on confidence", () => {
    const result = aggregate("JA-1", [
      verdict({ signal: "strong", engagementType: "donation", confidence: 0.4 }),
      verdict({
        signal: "strong",
        engagementType: "committee_board",
        confidence: 0.9,
        sentenceIndex: 1,
      }),
    ]);

    expect(result.engagementType).toBe("committee_board");
    expect(result.confidence).toBe(0.9);
  });

  describe("the signal/type invariant", () => {
    it("holds forward: a none signal always carries a null type", () => {
      // The model can emit this: the schema is flat, so nothing at the SDK
      // layer stops "none" arriving with a type attached.
      const result = aggregate("JA-1", [verdict({ signal: "none", engagementType: "donation" })]);

      expect(result.signal).toBe("none");
      expect(result.engagementType).toBeNull();
      expect(result.engagementTypes).toEqual([]);
    });

    it("holds backward: a typeless signal is demoted to none", () => {
      const result = aggregate("JA-1", [
        verdict({ signal: "strong", engagementType: null, quote: "Sign me up." }),
      ]);

      expect(result.signal).toBe("none");
      expect(result.engagementType).toBeNull();
    });

    it("ignores a contradictory verdict rather than letting it win", () => {
      const result = aggregate("JA-1", [
        verdict({ signal: "strong", engagementType: null }),
        verdict({ signal: "soft", engagementType: "speaking", sentenceIndex: 1 }),
      ]);

      expect(result.signal).toBe("soft");
      expect(result.engagementType).toBe("speaking");
    });
  });

  it("retains every distinct engagement type, not just the strongest", () => {
    const result = aggregate("JA-1", [
      verdict({ signal: "strong", engagementType: "speaking" }),
      verdict({ signal: "soft", engagementType: "refer_colleague", sentenceIndex: 1 }),
      verdict({ signal: "soft", engagementType: "speaking", sentenceIndex: 2 }),
    ]);

    expect(result.engagementTypes).toEqual(["speaking", "refer_colleague"]);
    expect(result.multiIntent).toBe(true);
  });

  it("does not call a single-type response multi-intent", () => {
    const result = aggregate("JA-1", [
      verdict({ signal: "strong", engagementType: "speaking" }),
      verdict({ signal: "soft", engagementType: "speaking", sentenceIndex: 1 }),
    ]);

    expect(result.engagementTypes).toEqual(["speaking"]);
    expect(result.multiIntent).toBe(false);
  });

  it("flags service recovery from any sentence, independent of signal", () => {
    const result = aggregate("JA-1", [
      verdict({ signal: "none", serviceRecovery: true, quote: "Nobody met me at the door." }),
    ]);

    expect(result.serviceRecovery).toBe(true);
    expect(result.signal).toBe("none");
  });

  it("keeps every verdict for the lead-detail view", () => {
    const verdicts = [verdict(), verdict({ sentenceIndex: 1 })];
    const result = aggregate("JA-1", verdicts);

    expect(result.verdicts).toEqual(verdicts);
    expect(result.responseId).toBe("JA-1");
  });
});
