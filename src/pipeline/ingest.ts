import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { Data, Effect } from "effect";

/**
 * One row of `data/volunteer_survey_export.csv`, all sixteen columns.
 *
 * Blank cells become `null` rather than `""` so that "the volunteer left this
 * empty" is distinguishable from "the volunteer typed nothing meaningful" at
 * every downstream call site. `q4_volunteer_again` and `opt_in_contact` are
 * tri-state on purpose: the export leaves them blank far more often than it
 * fills them, and PRD #1 §Error Modes 7 makes not-answered a distinct case from
 * answered-no.
 */
export type SurveyResponse = {
  responseId: string;
  submittedAt: string;
  program: string;
  school: string;
  volunteerName: string;
  volunteerEmail: string;
  employer: string;
  roleThisYear: string;
  q1OverallSatisfaction: number | null;
  q2WouldRecommend: number | null;
  q3FeltPrepared: number | null;
  q4VolunteerAgain: boolean | null;
  q5WhatWentWell: string | null;
  q6WhatCouldImprove: string | null;
  q7AnythingElse: string | null;
  optInContact: boolean | null;
};

export class IngestError extends Data.TaggedError("IngestError")<{
  readonly path: string;
  readonly reason: string;
}> {}

/** CSV header → the `SurveyResponse` key it populates. */
const COLUMNS = {
  response_id: "responseId",
  submitted_at: "submittedAt",
  program: "program",
  school: "school",
  volunteer_name: "volunteerName",
  volunteer_email: "volunteerEmail",
  employer: "employer",
  role_this_year: "roleThisYear",
  q1_overall_satisfaction: "q1OverallSatisfaction",
  q2_would_recommend: "q2WouldRecommend",
  q3_felt_prepared: "q3FeltPrepared",
  q4_volunteer_again: "q4VolunteerAgain",
  q5_what_went_well: "q5WhatWentWell",
  q6_what_could_improve: "q6WhatCouldImprove",
  q7_anything_else: "q7AnythingElse",
  opt_in_contact: "optInContact",
} as const;

const REQUIRED_HEADERS = Object.keys(COLUMNS);

function text(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function likert(raw: string | undefined): number | null {
  const value = text(raw);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function yesNo(raw: string | undefined): boolean | null {
  const value = text(raw)?.toLowerCase();
  if (value === undefined) return null;
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

/**
 * `responseId` is passed in already validated rather than defaulted here.
 *
 * It is the join key: every verdict, lead, and `run.json` row is addressed by
 * it, and the eval harness (#3) joins predictions to ground truth on it. A row
 * that silently became `""` would travel the whole pipeline and surface as a
 * lead nobody can trace back to a volunteer — the same silent-degradation
 * failure the header check exists to prevent, one column lower down.
 */
function toResponse(row: Record<string, string>, responseId: string): SurveyResponse {
  return {
    responseId,
    submittedAt: text(row.submitted_at) ?? "",
    program: text(row.program) ?? "",
    school: text(row.school) ?? "",
    volunteerName: text(row.volunteer_name) ?? "",
    volunteerEmail: text(row.volunteer_email) ?? "",
    employer: text(row.employer) ?? "",
    roleThisYear: text(row.role_this_year) ?? "",
    q1OverallSatisfaction: likert(row.q1_overall_satisfaction),
    q2WouldRecommend: likert(row.q2_would_recommend),
    q3FeltPrepared: likert(row.q3_felt_prepared),
    q4VolunteerAgain: yesNo(row.q4_volunteer_again),
    q5WhatWentWell: text(row.q5_what_went_well),
    q6WhatCouldImprove: text(row.q6_what_could_improve),
    q7AnythingElse: text(row.q7_anything_else),
    optInContact: yesNo(row.opt_in_contact),
  };
}

/**
 * Read the survey export into typed rows.
 *
 * Parsing is delegated to `csv-parse` rather than hand-split: `q7` prose
 * carries commas and newlines inside quotes, and hand-splitting silently
 * shreds exactly the rows this project exists to find (PRD #1 §Don't
 * Hand-Roll).
 *
 * A missing column is a hard failure, not a row of nulls. A header drift that
 * degrades to empty free text would produce a clean run reporting zero intent —
 * the most expensive way for this pipeline to be wrong.
 */
export function loadResponses(path: string): Effect.Effect<SurveyResponse[], IngestError> {
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new IngestError({ path, reason: `could not read file: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () =>
          parse(raw, {
            columns: true,
            skip_empty_lines: true,
            bom: true,
            relax_column_count: false,
          }) as Record<string, string>[],
        catch: (cause) => new IngestError({ path, reason: `malformed CSV: ${String(cause)}` }),
      }),
    ),
    Effect.flatMap((rows) => {
      const first = rows[0];
      if (first === undefined) {
        return Effect.fail(new IngestError({ path, reason: "no data rows" }));
      }

      const missing = REQUIRED_HEADERS.filter((column) => !(column in first));
      if (missing.length > 0) {
        return Effect.fail(
          new IngestError({ path, reason: `missing required column(s): ${missing.join(", ")}` }),
        );
      }

      const responses: SurveyResponse[] = [];
      for (const [index, row] of rows.entries()) {
        const responseId = text(row.response_id);
        if (responseId === null) {
          // +2: the header is line 1 and `index` is zero-based, so this is the
          // line number an operator will see when they open the CSV.
          return Effect.fail(
            new IngestError({ path, reason: `line ${index + 2} has no response_id` }),
          );
        }
        responses.push(toResponse(row, responseId));
      }
      return Effect.succeed(responses);
    }),
  );
}
