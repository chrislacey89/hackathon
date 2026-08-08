import { Effect } from "effect";
import type { Config } from "../config/load";
import type { SentenceVerdict } from "../domain/engagement";
import { aggregate, type ResponseVerdict } from "./aggregate";
import { classifyResponse } from "./classify";
import { type ClassifyError, emptyFailureCounts, type FailureCounts } from "./errors";
import type { SurveyResponse } from "./ingest";

export type SweepResult = {
  verdicts: ResponseVerdict[];
  failures: FailureCounts;
  /** True when any row exhausted its retries — the run does not describe the whole export. */
  partial: boolean;
  attempted: number;
};

export type SweepOptions = {
  /** Injected so reliability behaviour is testable without a model call. */
  classify?: (response: SurveyResponse) => Effect.Effect<SentenceVerdict[], ClassifyError>;
};

/**
 * Classify every row, bounded and counted.
 *
 * The error channel is `never` by design: a sweep that fails is a sweep that
 * loses the 383 rows that worked. Every row's failure is caught, counted by
 * tag, and turned into `partial`.
 */
export function sweep(
  rows: SurveyResponse[],
  config: Config,
  options: SweepOptions = {},
): Effect.Effect<SweepResult, never> {
  const classify = options.classify ?? classifyResponse;
  const failures = emptyFailureCounts();

  return Effect.forEach(
    rows,
    (row) =>
      classify(row).pipe(
        Effect.map((verdicts) => aggregate(row.responseId, verdicts)),
        Effect.catchAll((error: ClassifyError) => {
          failures[error._tag] += 1;
          return Effect.succeed(null);
        }),
      ),
    { concurrency: config.concurrency },
  ).pipe(
    Effect.map((settled) => ({
      verdicts: settled.filter((v): v is ResponseVerdict => v !== null),
      failures,
      partial: Object.values(failures).some((n) => n > 0),
      attempted: rows.length,
    })),
  );
}
