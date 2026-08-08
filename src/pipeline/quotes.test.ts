import { describe, expect, it } from "vitest";
import type { SurveyResponse } from "./ingest";
import { consentOf } from "./quotes";

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
