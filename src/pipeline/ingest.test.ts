import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { IngestError, loadResponses } from "./ingest";

const EXPORT_PATH = "data/volunteer_survey_export.csv";

/** All sixteen columns present, but `response_id` blank — the join key is gone. */
const FIRST_ROW_RAW = {
  response_id: "",
  submitted_at: "2025-12-28T13:45",
  program: "JA Company Program",
  school: "Wayne HS",
  volunteer_name: "Casey Dupree",
  volunteer_email: "casey.dupree@three.com",
  employer: "Three Rivers Credit Union",
  role_this_year: "Classroom Volunteer",
  q1_overall_satisfaction: "4",
  q2_would_recommend: "5",
  q3_felt_prepared: "3",
  q4_volunteer_again: "",
  q5_what_went_well: "Staff support was excellent.",
  q6_what_could_improve: "More time with the students.",
  q7_anything_else: "",
  opt_in_contact: "Yes",
};

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
    if (result._tag === "Left") {
      // Names the actual cause, so the test cannot pass on an unrelated failure
      // and the message an operator sees stays useful.
      expect(result.left.reason).toMatch(/missing required column\(s\)/);
      expect(result.left.reason).toContain("submitted_at");
    }
  });

  it("fails on a row missing the response_id it will be joined on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vir-ingest-"));
    const path = join(dir, "no-id.csv");
    const header = Object.keys(FIRST_ROW_RAW).join(",");
    await writeFile(path, `${header}\n${Object.values(FIRST_ROW_RAW).join(",")}\n`);

    const result = await Effect.runPromise(Effect.either(loadResponses(path)));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.reason).toMatch(/line 2 has no response_id/);
  });
});
