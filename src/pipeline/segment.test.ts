import { describe, expect, it } from "vitest";
import type { SurveyResponse } from "./ingest";
import { segmentResponse } from "./segment";

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-00001",
    submittedAt: "2026-01-01T09:00",
    program: "JA in a Day",
    school: "Test HS",
    volunteerName: "Test Volunteer",
    volunteerEmail: "test@example.com",
    employer: "Test Co",
    roleThisYear: "Classroom Volunteer",
    q1OverallSatisfaction: 4,
    q2WouldRecommend: 4,
    q3FeltPrepared: 4,
    q4VolunteerAgain: null,
    q5WhatWentWell: null,
    q6WhatCouldImprove: null,
    q7AnythingElse: null,
    optInContact: null,
    ...overrides,
  };
}

describe("segmentResponse", () => {
  it("splits a column into its sentences, carrying the response id", () => {
    const sentences = segmentResponse(
      response({ q5WhatWentWell: "The students were engaged. Staff support was excellent." }),
    );

    expect(sentences).toEqual([
      {
        responseId: "JA-00001",
        column: "q5_what_went_well",
        index: 0,
        text: "The students were engaged.",
      },
      {
        responseId: "JA-00001",
        column: "q5_what_went_well",
        index: 1,
        text: "Staff support was excellent.",
      },
    ]);
  });

  it("reads all three free-text columns in q5, q6, q7 order", () => {
    const sentences = segmentResponse(
      response({
        q5WhatWentWell: "Went well.",
        q6WhatCouldImprove: "Could improve.",
        q7AnythingElse: "Anything else.",
      }),
    );

    expect(sentences.map((s) => s.column)).toEqual([
      "q5_what_went_well",
      "q6_what_could_improve",
      "q7_anything_else",
    ]);
  });

  it("numbers sentences per column, not across the whole response", () => {
    const sentences = segmentResponse(
      response({
        q5WhatWentWell: "One. Two.",
        q6WhatCouldImprove: "Three.",
      }),
    );

    expect(sentences.map((s) => `${s.column}#${s.index}`)).toEqual([
      "q5_what_went_well#0",
      "q5_what_went_well#1",
      "q6_what_could_improve#0",
    ]);
  });

  it("skips blank and whitespace-only columns entirely", () => {
    const sentences = segmentResponse(
      response({ q5WhatWentWell: "   ", q6WhatCouldImprove: null, q7AnythingElse: "Real text." }),
    );

    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.column).toBe("q7_anything_else");
    expect(sentences[0]?.index).toBe(0);
  });

  it("trims trailing whitespace off each sentence", () => {
    const sentences = segmentResponse(response({ q7AnythingElse: "  First.   Second.  " }));

    expect(sentences.map((s) => s.text)).toEqual(["First.", "Second."]);
  });

  it("isolates buried intent from the complaint it is attached to", () => {
    // JA-24378 — the planted case. Intent lives in q6, wrapped in a complaint.
    // If the splitter merges these two sentences, the quote a JA staffer sees
    // leads with "more prep time would help" instead of the offer.
    const sentences = segmentResponse(
      response({
        responseId: "JA-24378",
        q6WhatCouldImprove: "More prep time would help. That said, put me down for next fall.",
      }),
    );

    expect(sentences.map((s) => s.text)).toEqual([
      "More prep time would help.",
      "That said, put me down for next fall.",
    ]);
  });

  it("keeps text with no terminal punctuation as a single sentence", () => {
    const sentences = segmentResponse(response({ q5WhatWentWell: "Good" }));

    expect(sentences).toEqual([
      { responseId: "JA-00001", column: "q5_what_went_well", index: 0, text: "Good" },
    ]);
  });

  it("returns nothing for a response with no free text at all", () => {
    expect(segmentResponse(response())).toEqual([]);
  });
});
