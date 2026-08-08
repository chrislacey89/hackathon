import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { Data, Effect } from "effect";
import {
  ENGAGEMENT_SIGNALS,
  type EngagementSignal,
  type EngagementType,
  FREE_TEXT_COLUMNS,
  type FreeTextColumn,
} from "../domain/engagement";

/**
 * The engagement vocabulary of `data/ground_truth_labeled_sample.csv` — and of
 * nothing else.
 *
 * These six were the project's taxonomy when the 150 rows were labeled, and
 * they are frozen here because the file is frozen: it is a committed artifact
 * with a fixed set of values in one column, so its allowed members are a
 * property of the file in the same way `REQUIRED_HEADERS` is.
 *
 * They are **not** JA's categories. Karen's list (`config/categories.json`)
 * adds *donate SWAG*, splits volunteering by programme, and does not contain
 * `speaking`, `refer_colleague`, or `committee_board` at all (#24 §2). The two
 * schemes are disjoint, which is why PRD #1 §Rabbit Holes scores signal and
 * service-recovery — both taxonomy-independent — and drops per-type accuracy.
 * Re-labelling the sample against JA's taxonomy is the real cost there, and it
 * belongs to #10, not here.
 *
 * Validating this column against JA's config instead would fail all 150 rows on
 * load — a hard failure that would be technically correct and completely
 * useless, since the labels are not wrong, they are answering a different
 * question.
 */
export const LABELED_SAMPLE_TYPES = [
  "volunteer_again",
  "committee_board",
  "corporate_sponsorship",
  "refer_colleague",
  "speaking",
  "donation",
] as const;

/**
 * One row of `data/ground_truth_labeled_sample.csv` — a human's judgement about
 * one survey response, and the only thing in this project entitled to be called
 * correct.
 *
 * `engagementType` and `signalFoundInColumn` are `null` exactly when
 * `engagementSignal` is `none`, mirroring the invariant `aggregate` enforces on
 * the prediction side. The labels satisfy it in all 150 rows today; `evaluate`
 * does not assume it, because a label that violates it is unscorable rather
 * than merely surprising, and the harness has to say so out loud.
 */
export type GroundTruth = {
  responseId: string;
  engagementSignal: EngagementSignal;
  engagementType: EngagementType | null;
  signalFoundInColumn: FreeTextColumn | null;
  serviceRecoveryFlag: boolean;
};

export class GroundTruthError extends Data.TaggedError("GroundTruthError")<{
  readonly path: string;
  readonly reason: string;
}> {}

const REQUIRED_HEADERS = [
  "response_id",
  "engagement_signal",
  "engagement_type",
  "signal_found_in_column",
  "service_recovery_flag",
];

function text(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * A vocabulary mismatch is a hard failure, not a `null`.
 *
 * Degrading an unrecognised label to "no signal" would quietly move rows into
 * the `none` class and *improve* every reported number, because `none` is 70%
 * of the sample. A metric that gets better as the data gets worse is the one
 * kind of wrong this harness must not be.
 */
function member<T extends string>(
  allowed: readonly T[],
  raw: string | undefined,
): T | null | "invalid" {
  const value = text(raw);
  if (value === null) return null;
  return allowed.includes(value as T) ? (value as T) : "invalid";
}

/**
 * Read the labeled sample into typed rows.
 *
 * The counterpart to `loadResponses`, and deliberately just as strict: this
 * file is the project's only ground truth, so a column that silently arrives
 * empty would not produce a visible failure — it would produce a *confident
 * wrong number*, which is worse than a crash and much harder to notice.
 */
export function loadGroundTruth(path: string): Effect.Effect<GroundTruth[], GroundTruthError> {
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new GroundTruthError({ path, reason: `could not read file: ${String(cause)}` }),
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
        catch: (cause) => new GroundTruthError({ path, reason: `malformed CSV: ${String(cause)}` }),
      }),
    ),
    Effect.flatMap((rows) => {
      const first = rows[0];
      if (first === undefined) {
        return Effect.fail(new GroundTruthError({ path, reason: "no data rows" }));
      }

      const missing = REQUIRED_HEADERS.filter((column) => !(column in first));
      if (missing.length > 0) {
        return Effect.fail(
          new GroundTruthError({
            path,
            reason: `missing required column(s): ${missing.join(", ")}`,
          }),
        );
      }

      const labels: GroundTruth[] = [];
      for (const [index, row] of rows.entries()) {
        // +2: the header is line 1 and `index` is zero-based, so this is the
        // line number an operator will see when they open the CSV.
        const line = index + 2;

        const responseId = text(row.response_id);
        if (responseId === null) {
          return Effect.fail(
            new GroundTruthError({ path, reason: `line ${line} has no response_id` }),
          );
        }

        const signal = member(ENGAGEMENT_SIGNALS, row.engagement_signal);
        if (signal === null || signal === "invalid") {
          return Effect.fail(
            new GroundTruthError({
              path,
              reason: `line ${line} has unrecognised engagement_signal "${row.engagement_signal ?? ""}"`,
            }),
          );
        }

        const engagementType = member(LABELED_SAMPLE_TYPES, row.engagement_type);
        if (engagementType === "invalid") {
          return Effect.fail(
            new GroundTruthError({
              path,
              reason: `line ${line} has unrecognised engagement_type "${row.engagement_type ?? ""}"`,
            }),
          );
        }

        const signalFoundInColumn = member(FREE_TEXT_COLUMNS, row.signal_found_in_column);
        if (signalFoundInColumn === "invalid") {
          return Effect.fail(
            new GroundTruthError({
              path,
              reason: `line ${line} has unrecognised signal_found_in_column "${row.signal_found_in_column ?? ""}"`,
            }),
          );
        }

        const flag = text(row.service_recovery_flag)?.toUpperCase();
        if (flag !== "Y" && flag !== "N") {
          return Effect.fail(
            new GroundTruthError({
              path,
              reason: `line ${line} has unrecognised service_recovery_flag "${row.service_recovery_flag ?? ""}"`,
            }),
          );
        }

        labels.push({
          responseId,
          engagementSignal: signal satisfies EngagementSignal,
          engagementType: engagementType satisfies EngagementType | null,
          signalFoundInColumn: signalFoundInColumn satisfies FreeTextColumn | null,
          serviceRecoveryFlag: flag === "Y",
        });
      }
      return Effect.succeed(labels);
    }),
  );
}
