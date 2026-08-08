import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { Data, Effect } from "effect";
import {
  ENGAGEMENT_SIGNALS,
  ENGAGEMENT_TYPES,
  type EngagementSignal,
  type EngagementType,
  FREE_TEXT_COLUMNS,
  type FreeTextColumn,
} from "../domain/engagement";

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

        const engagementType = member(ENGAGEMENT_TYPES, row.engagement_type);
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
