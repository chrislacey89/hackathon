import { describe, expect, it } from "vitest";
import type { SurveyResponse } from "../pipeline/ingest";
import { keywordBaseline } from "./baseline";

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-1",
    submittedAt: "2025-12-28T13:45",
    program: "JA Company Program",
    school: "Wayne HS",
    volunteerName: "Casey Dupree",
    volunteerEmail: "casey.dupree@three.com",
    employer: "Three Rivers Credit Union",
    roleThisYear: "Classroom Volunteer",
    q1OverallSatisfaction: 4,
    q2WouldRecommend: 5,
    q3FeltPrepared: 3,
    q4VolunteerAgain: null,
    q5WhatWentWell: null,
    q6WhatCouldImprove: null,
    q7AnythingElse: null,
    optInContact: null,
    ...overrides,
  };
}

describe("keywordBaseline", () => {
  it("calls an explicit commitment a strong signal", () => {
    const [verdict] = keywordBaseline([
      response({ q7AnythingElse: "I would love to come back. Sign me up for the spring session." }),
    ]);

    expect(verdict?.signal).toBe("strong");
  });

  it("calls hedged interest a soft signal", () => {
    const [verdict] = keywordBaseline([
      response({ q7AnythingElse: "Possibly next year, depending on my travel schedule." }),
    ]);

    expect(verdict?.signal).toBe("soft");
  });

  it("finds no signal in ordinary satisfied feedback", () => {
    const [verdict] = keywordBaseline([
      response({
        q5WhatWentWell: "The students were engaged.",
        q6WhatCouldImprove: "More time with the students.",
      }),
    ]);

    expect(verdict?.signal).toBe("none");
    expect(verdict?.engagementType).toBeNull();
  });

  it("reads intent out of the what-could-improve box, not just the last one", () => {
    const [verdict] = keywordBaseline([
      response({
        q6WhatCouldImprove: "More prep time would help. That said, put me down for next fall.",
      }),
    ]);

    expect(verdict?.signal).toBe("strong");
    expect(verdict?.sourceColumn).toBe("q6_what_could_improve");
  });

  it("cites the sentence that triggered the signal, not the whole box", () => {
    const [verdict] = keywordBaseline([
      response({
        q7AnythingElse: "Thanks for organising this. Please add me to your speaker list.",
      }),
    ]);

    expect(verdict?.quote).toBe("Please add me to your speaker list.");
  });

  describe("names the kind of engagement from the whole response", () => {
    const cases: [string, string][] = [
      ["Please add me to your speaker list - I can do a career day.", "speaking"],
      ["My firm would consider underwriting a school.", "corporate_sponsorship"],
      ["I want to sponsor a class next year.", "donation"],
      ["Is there a way to get involved beyond the classroom? I'd like to help.", "committee_board"],
      ["I'd like to bring this program to my daughter's school.", "refer_colleague"],
      ["Put me down for all three sessions next year.", "volunteer_again"],
    ];

    for (const [prose, expected] of cases) {
      it(`reads "${expected}"`, () => {
        const [verdict] = keywordBaseline([response({ q7AnythingElse: prose })]);

        expect(verdict?.engagementType).toBe(expected);
      });
    }

    // The type cue and the commitment live in different sentences. Matching
    // types per sentence scores the commitment and loses the type — which on
    // dev put every committee_board row into volunteer_again.
    it("finds a type named in a different sentence from the commitment", () => {
      const [verdict] = keywordBaseline([
        response({
          q7AnythingElse: "Is there a way to get involved beyond the classroom? Please call me.",
        }),
      ]);

      expect(verdict?.signal).toBe("strong");
      expect(verdict?.engagementType).toBe("committee_board");
    });
  });

  it("flags a complaint independently of whether there is any intent", () => {
    const [verdict] = keywordBaseline([
      response({ q6WhatCouldImprove: "Parking was a nightmare and no one met me at the door." }),
    ]);

    expect(verdict?.serviceRecovery).toBe(true);
    expect(verdict?.signal).toBe("none");
  });

  // The eval join is total. A baseline returning only its hits would fail the
  // join rather than quietly scoring against a smaller denominator.
  it("returns one verdict per input row, including rows with nothing written in them", () => {
    const verdicts = keywordBaseline([
      response({ responseId: "JA-1", q7AnythingElse: "Sign me up." }),
      response({ responseId: "JA-2" }),
      response({ responseId: "JA-3", q5WhatWentWell: "Good program." }),
    ]);

    expect(verdicts.map((v) => v.responseId)).toEqual(["JA-1", "JA-2", "JA-3"]);
  });

  it("holds the signal/type invariant it inherits from aggregate", () => {
    const verdicts = keywordBaseline([
      response({ responseId: "JA-1", q7AnythingElse: "Sign me up for the spring session." }),
      response({ responseId: "JA-2", q5WhatWentWell: "The materials were clear." }),
    ]);

    for (const verdict of verdicts) {
      expect(verdict.signal === "none").toBe(verdict.engagementType === null);
    }
  });
});
