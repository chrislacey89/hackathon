import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { IngestError, loadResponses } from "./ingest";

const EXPORT_PATH = "data/volunteer_survey_export.csv";

describe("loadResponses", () => {
  it("reads every row of the survey export", async () => {
    const rows = await Effect.runPromise(loadResponses(EXPORT_PATH));

    expect(rows).toHaveLength(384);
  });

  it("keeps a quoted free-text field intact when it contains a comma", async () => {
    const rows = await Effect.runPromise(loadResponses(EXPORT_PATH));
    const planted = rows.find((r) => r.responseId === "JA-24378");

    expect(planted?.q6WhatCouldImprove).toBe(
      "More prep time would help. That said, put me down for next fall.",
    );
  });

  it("exposes all sixteen survey columns on a row", async () => {
    const rows = await Effect.runPromise(loadResponses(EXPORT_PATH));
    const first = rows[0];

    expect(first).toEqual({
      responseId: "JA-24001",
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
      q5WhatWentWell: "Staff support was excellent.",
      q6WhatCouldImprove: "More time with the students.",
      q7AnythingElse: "If you're ever short someone last minute, I might be able to fill in.",
      optInContact: true,
    });
  });

  it("fails with a typed IngestError when the file is missing", async () => {
    const result = await Effect.runPromise(Effect.either(loadResponses("data/nope.csv")));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(IngestError);
      expect(result.left._tag).toBe("IngestError");
    }
  });

  it("fails rather than returning partial rows when a required column is absent", async () => {
    const result = await Effect.runPromise(
      Effect.either(loadResponses("data/ground_truth_labeled_sample.csv")),
    );

    expect(result._tag).toBe("Left");
  });
});
