import { type Duration, Effect, Schedule } from "effect";
import type { Config } from "../config/load";
import type { SentenceVerdict } from "../domain/engagement";
import { aggregate, type ResponseVerdict } from "./aggregate";
import { classifyResponse } from "./classify";
import { type ClassifyError, emptyFailureCounts, type FailureCounts, isRetryable } from "./errors";
import type { SurveyResponse } from "./ingest";

export type SweepResult = {
  verdicts: ResponseVerdict[];
  failures: FailureCounts;
  /** True when any row exhausted its retries — the run does not describe the whole export. */
  partial: boolean;
  attempted: number;
};

export type RetryPolicy = {
  /** Attempts *after* the first. A budget of 3 means four calls at worst. */
  maxRetries: number;
  /** First backoff step; each retry doubles it, jittered. */
  baseDelay: Duration.DurationInput;
};

/**
 * Three retries from one second.
 *
 * Sized against JA's real cadence rather than the demo: ~5,400 responses a year
 * across four markets processed weekly is ~105 rows per run, not a 384-row
 * burst (research artifact, Volume revision). At that volume a rate limit is
 * something to ride out politely, so the budget is small and the first step is
 * long enough to matter. Worst case a fully rate-limited row waits about seven
 * seconds before it is counted and the run moves on.
 */
export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 3, baseDelay: "1 seconds" };

export type SweepOptions = {
  /** Injected so reliability behaviour is testable without a model call. */
  classify?: (response: SurveyResponse) => Effect.Effect<SentenceVerdict[], ClassifyError>;
  /** Injected so tests can turn the wall clock off rather than sleep through backoff. */
  retry?: RetryPolicy;
};

/**
 * Classify every row, bounded and counted.
 *
 * The error channel is `never` by design, and the compiler is what enforces it:
 * a sweep that fails is a sweep that throws away the 383 rows that worked, so
 * every row's failure is caught inside the row, counted by tag, and surfaced as
 * `partial`. Catching *inside* the row also matters for a second reason —
 * `Effect.forEach` interrupts its siblings on the first failure, so a single
 * 429 would otherwise take the concurrent rows down with it.
 *
 * Defects are deliberately *not* caught. A thrown exception is a bug in this
 * code, not a provider failure, and there is no honest tag for it: counting it
 * as `Transient` would file a crash under a reliability number and hide it.
 * It propagates to `Effect.runPromise` at the entry point, which exits non-zero
 * and writes no run — a loud failure, which is what PRD #1 asks a bad week to be.
 */
export function sweep(
  rows: SurveyResponse[],
  config: Config,
  options: SweepOptions = {},
): Effect.Effect<SweepResult, never> {
  // The categories ride from config into every call. They are the run's
  // taxonomy now that #27 made them config-defined rather than an enum, so the
  // sweep binds them once here rather than asking each caller to thread them.
  const classify =
    options.classify ?? ((row: SurveyResponse) => classifyResponse(row, config.categories));
  const { maxRetries, baseDelay } = options.retry ?? DEFAULT_RETRY;
  const failures = emptyFailureCounts();

  // Jittered so 384 rows that hit the same limit in the same second do not all
  // wake up in the same second and hit it again.
  const schedule = Schedule.exponential(baseDelay).pipe(Schedule.jittered);

  return Effect.forEach(
    rows,
    (row) =>
      classify(row).pipe(
        Effect.retry({ schedule, while: isRetryable, times: maxRetries }),
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
