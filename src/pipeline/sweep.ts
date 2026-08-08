import { Effect, Schedule } from "effect";
import type { Config } from "../config/load";
import { aggregate } from "./aggregate";
import { type ClassifyError, classifyResponse } from "./classify";
import type { SurveyResponse } from "./ingest";
import { type RoutedLead, route } from "./route";

export type FailureCounts = Record<string, number>;

export type SweepResult = {
  leads: RoutedLead[];
  failures: FailureCounts;
  /** True when any row exhausted its retries. A partial run must never render as complete. */
  partial: boolean;
  attempted: number;
};

export type SweepOptions = {
  /** Overrides `config.concurrency`. Set from the AI Studio dashboard, never guessed. */
  concurrency?: number;
  /** Retry attempts for transient failures. Zero disables retry, which is what tests use. */
  retries?: number;
  /** Called after each row settles, for progress on a 384-row run. */
  onProgress?: (done: number, total: number) => void;
};

/**
 * Failures worth retrying.
 *
 * A rate limit or a dropped connection is a different request away from
 * succeeding; a malformed-output error is deterministic, and retrying it burns
 * quota for a guaranteed-identical failure (PRD #1 §Rabbit Holes). `classify`
 * currently reports one error tag, so this discriminates on the provider's
 * message — cruder than slice #4's planned taxonomy, and deliberately biased
 * toward *not* retrying: an unmatched reason fails through and is counted.
 */
const TRANSIENT = /429|rate.?limit|quota|timeout|ETIMEDOUT|ECONNRESET|socket|50[0234]|overloaded/i;

function isTransient(error: ClassifyError): boolean {
  return TRANSIENT.test(error.reason);
}

/** Group failures by a short reason tag, so the report says *how* it failed, not just how often. */
function tagOf(error: ClassifyError): string {
  return isTransient(error) ? "Transient" : "SchemaInvalid";
}

/**
 * Classify, aggregate, and route every response in the export.
 *
 * Total by construction: this Effect cannot fail. A row that exhausts its
 * retries is counted by tag and omitted from `leads`, and the run continues —
 * a sweep that dies on row 200 of 384 would leave the operator with nothing,
 * which is strictly worse than a run that says "380 of 384, here are the 4
 * that failed and why."
 *
 * `Effect.forEach` is called with an **explicit** concurrency. Its default is
 * 1, which would silently serialize 384 network calls (research artifact, and
 * the reason this is called out here rather than left to a reader).
 */
export function sweep(
  rows: SurveyResponse[],
  config: Config,
  options: SweepOptions = {},
): Effect.Effect<SweepResult, never> {
  const concurrency = options.concurrency ?? config.concurrency;
  const retries = options.retries ?? 3;
  const failures: FailureCounts = {};
  let done = 0;

  const classifyOne = (response: SurveyResponse) => {
    const attempt = classifyResponse(response);
    return retries > 0
      ? Effect.retry(attempt, {
          schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
          while: isTransient,
          times: retries,
        })
      : attempt;
  };

  const one = (response: SurveyResponse) =>
    classifyOne(response).pipe(
      Effect.map((verdicts) => route(aggregate(response.responseId, verdicts), response, config)),
      Effect.catchAll((error) => {
        const tag = tagOf(error);
        failures[tag] = (failures[tag] ?? 0) + 1;
        return Effect.succeed(null);
      }),
      Effect.tap(() =>
        Effect.sync(() => {
          done += 1;
          options.onProgress?.(done, rows.length);
        }),
      ),
    );

  return Effect.forEach(rows, one, { concurrency }).pipe(
    Effect.map((settled) => {
      const leads = settled.filter((lead): lead is RoutedLead => lead !== null);
      return {
        leads,
        failures,
        partial: leads.length < rows.length,
        attempted: rows.length,
      };
    }),
  );
}
