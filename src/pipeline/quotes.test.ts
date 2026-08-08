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
});
