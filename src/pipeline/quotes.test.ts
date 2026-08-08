import { describe, expect, it } from "vitest";
import type { SentenceVerdict } from "../domain/engagement";
import type { ResponseVerdict } from "./aggregate";
import type { SurveyResponse } from "./ingest";
import { consentOf, extractQuotes } from "./quotes";

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-1",
    submittedAt: "2026-01-05",
    program: "JA BizTown",
    school: "Northside Elementary",
    volunteerName: "Ada Lovelace",
    volunteerEmail: "ada@example.com",
    employer: "Analytical Engines",
    roleThisYear: "Classroom volunteer",
    q1OverallSatisfaction: 5,
    q2WouldRecommend: 5,
    q3FeltPrepared: 4,
    q4VolunteerAgain: true,
    q5WhatWentWell: null,
    q6WhatCouldImprove: null,
    q7AnythingElse: null,
    optInContact: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<SentenceVerdict> = {}): SentenceVerdict {
  return {
    column: "q5_what_went_well",
    sentenceIndex: 0,
    quote: "The students asked better questions than the adults do.",
    signal: "none",
    engagementType: null,
    confidence: 0.9,
    serviceRecovery: false,
    quotable: true,
    ...overrides,
  };
}

function responseVerdict(overrides: Partial<ResponseVerdict> = {}): ResponseVerdict {
  return {
    responseId: "JA-1",
    signal: "none",
    engagementType: null,
    engagementTypes: [],
    confidence: 0,
    quote: null,
    sourceColumn: null,
    serviceRecovery: false,
    multiIntent: false,
    verdicts: [verdict()],
    ...overrides,
  };
}

describe("consentOf", () => {
  it("reads an explicit yes as granted", () => {
    expect(consentOf(response({ optInContact: true }))).toBe("granted");
  });

  it("reads an explicit no as declined", () => {
    expect(consentOf(response({ optInContact: false }))).toBe("declined");
  });

  it("reads a blank as needs_check rather than assuming either answer", () => {
    expect(consentOf(response({ optInContact: null }))).toBe("needs_check");
  });
});

describe("extractQuotes", () => {
  it("carries the attribution a grants writer needs to use the quote", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true, volunteerName: "Ada Lovelace", program: "JA BizTown" })],
      [responseVerdict()],
    );

    expect(candidates).toEqual([
      {
        responseId: "JA-1",
        quote: "The students asked better questions than the adults do.",
        sourceColumn: "q5_what_went_well",
        volunteerName: "Ada Lovelace",
        program: "JA BizTown",
        consent: "granted",
      },
    ]);
  });

  it("draws nothing at all from a volunteer who declined contact", () => {
    const candidates = extractQuotes(
      [response({ optInContact: false })],
      [responseVerdict({ verdicts: [verdict({ quotable: true })] })],
    );

    expect(candidates).toEqual([]);
  });

  it("keeps a blank-consent quote, marked for a human to check", () => {
    const candidates = extractQuotes([response({ optInContact: null })], [responseVerdict()]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.consent).toBe("needs_check");
  });

  it("ignores a sentence the model judged unquotable", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [responseVerdict({ verdicts: [verdict({ quotable: false })] })],
    );

    expect(candidates).toEqual([]);
  });

  it("ignores a sentence nobody judged, rather than treating null as a yes", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [responseVerdict({ verdicts: [verdict({ quotable: null })] })],
    );

    expect(candidates).toEqual([]);
  });

  it("collects a quote from a volunteer with no engagement signal whatsoever", () => {
    // The slice's reason for existing. A response nobody would ever route can
    // still hold the best line in the export, so quotability must not be
    // reachable from signal in either direction.
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [
        responseVerdict({
          signal: "none",
          engagementType: null,
          quote: null,
          sourceColumn: null,
          verdicts: [verdict({ signal: "none", engagementType: null, quotable: true })],
        }),
      ],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.quote).toBe("The students asked better questions than the adults do.");
  });

  it("collects every quotable sentence in a response, not just the strongest", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [
        responseVerdict({
          verdicts: [
            verdict({ quote: "First good line.", quotable: true }),
            verdict({ sentenceIndex: 1, quote: "Middling line.", quotable: false }),
            verdict({ sentenceIndex: 2, quote: "Second good line.", quotable: true }),
          ],
        }),
      ],
    );

    expect(candidates.map((c) => c.quote)).toEqual(["First good line.", "Second good line."]);
  });

  it("fails loudly when a verdict has no survey row to attribute it to", () => {
    expect(() => extractQuotes([], [responseVerdict({ responseId: "JA-404" })])).toThrow("JA-404");
  });
});
