import { describe, expect, it } from "vitest";
import type { SentenceVerdict } from "../domain/engagement";
import type { RoutedLead } from "../pipeline/route";
import { isBuried, leadContext } from "./lead-context";

function verdict(overrides: Partial<SentenceVerdict> = {}): SentenceVerdict {
  return {
    column: "q6_what_could_improve",
    sentenceIndex: 0,
    quote: "More prep time would help.",
    signal: "none",
    engagementType: null,
    confidence: 0.9,
    serviceRecovery: false,
    quotable: null,
    ...overrides,
  };
}

function lead(overrides: Partial<RoutedLead> = {}): RoutedLead {
  return {
    responseId: "JA-24378",
    signal: "strong",
    engagementType: "volunteer_again",
    engagementTypes: ["volunteer_again"],
    confidence: 0.98,
    quote: "That said, put me down for next fall.",
    sourceColumn: "q6_what_could_improve",
    serviceRecovery: false,
    multiIntent: false,
    verdicts: [
      verdict({ sentenceIndex: 0, quote: "More prep time would help." }),
      verdict({
        sentenceIndex: 1,
        quote: "That said, put me down for next fall.",
        signal: "strong",
        engagementType: "volunteer_again",
      }),
    ],
    teamId: "placeholder-team",
    recipientIds: ["recipient-placeholder"],
    county: "Allen",
    school: "Wayne HS",
    submittedAt: "2026-01-15T20:15",
    name: "Lucia Nunez",
    email: "lucia@example.com",
    employer: "Bluffton Steel Works",
    program: "JA BizTown",
    ...overrides,
  };
}

describe("leadContext", () => {
  it("puts the complaint before the offer it was buried in", () => {
    // The planted case, and the demo's central claim rendered from data.
    const context = leadContext(lead());

    expect(context.before).toBe("More prep time would help.");
    expect(context.trigger).toBe("That said, put me down for next fall.");
    expect(context.after).toBe("");
    expect(context.buriedInContext).toBe(true);
  });

  it("keeps sentences that followed the offer", () => {
    const context = leadContext(
      lead({
        verdicts: [
          verdict({ sentenceIndex: 0, quote: "Loved it." }),
          verdict({ sentenceIndex: 1, quote: "That said, put me down for next fall." }),
          verdict({ sentenceIndex: 2, quote: "Thanks again." }),
        ],
      }),
    );

    expect(context.before).toBe("Loved it.");
    expect(context.after).toBe("Thanks again.");
  });

  it("orders by sentence index, not array order", () => {
    const context = leadContext(
      lead({
        verdicts: [
          verdict({ sentenceIndex: 2, quote: "Third." }),
          verdict({ sentenceIndex: 1, quote: "That said, put me down for next fall." }),
          verdict({ sentenceIndex: 0, quote: "First." }),
        ],
      }),
    );

    expect(context.before).toBe("First.");
    expect(context.after).toBe("Third.");
  });

  it("ignores sentences from other columns", () => {
    // q5 text must never be presented as if it surrounded the q6 offer.
    const context = leadContext(
      lead({
        verdicts: [
          verdict({ column: "q5_what_went_well", sentenceIndex: 0, quote: "Staff were great." }),
          verdict({ sentenceIndex: 0, quote: "That said, put me down for next fall." }),
        ],
      }),
    );

    expect(context.before).toBe("");
    expect(context.buriedInContext).toBe(false);
  });

  it("reports not-buried when the offer stood alone", () => {
    const context = leadContext(
      lead({
        verdicts: [verdict({ sentenceIndex: 0, quote: "That said, put me down for next fall." })],
      }),
    );

    expect(context.buriedInContext).toBe(false);
    expect(context.trigger).toBe("That said, put me down for next fall.");
  });

  describe("falls back to trigger-only rather than guessing", () => {
    it("when no verdict matches the quote", () => {
      const context = leadContext(lead({ verdicts: [verdict({ quote: "Unrelated." })] }));

      expect(context.before).toBe("");
      expect(context.after).toBe("");
      expect(context.trigger).toBe("That said, put me down for next fall.");
    });

    it("when the lead has no quote at all", () => {
      expect(leadContext(lead({ quote: null })).trigger).toBe("");
    });

    it("when the source column is unknown", () => {
      expect(leadContext(lead({ sourceColumn: null })).before).toBe("");
    });
  });
});

describe("isBuried", () => {
  it("is true for a signal-carrying lead from the improve column", () => {
    expect(isBuried(lead())).toBe(true);
  });

  it("is false for the same column with no signal", () => {
    expect(isBuried(lead({ signal: "none" }))).toBe(false);
  });

  it("is false for a signal found where anyone would look", () => {
    expect(isBuried(lead({ sourceColumn: "q7_anything_else" }))).toBe(false);
  });
});
