import { APICallError, NoObjectGeneratedError, TypeValidationError } from "ai";
import { Data } from "effect";

/**
 * The failure taxonomy for a classification call.
 *
 * Three tags, and the split is not cosmetic — it is the whole reason Effect is
 * here. `RateLimited` and `Transient` are worth retrying because the same call
 * may succeed later; `SchemaInvalid` is not, because a malformed generation is
 * deterministic and a retry buys a guaranteed-identical failure at the cost of
 * quota we are already unsure we have (PRD #1 §Rabbit Holes).
 *
 * A hand-rolled `if (status === 429)` inside a catch block is where this gets
 * ugly. A tag plus a predicate is where it stays declarative.
 */

export class RateLimited extends Data.TaggedError("RateLimited")<{
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfter?: number;
}> {}

export class SchemaInvalid extends Data.TaggedError("SchemaInvalid")<{
  readonly responseId: string;
}> {}

export class Transient extends Data.TaggedError("Transient")<{
  readonly status: number;
}> {}

export type ClassifyError = RateLimited | SchemaInvalid | Transient;

/**
 * Every tag, in report order. One array so the counter, the zero value, and
 * any future summary read from the same list rather than three copies that can
 * drift — the same single-constant discipline `ENGAGEMENT_TYPES` uses.
 */
export const FAILURE_TAGS = ["RateLimited", "SchemaInvalid", "Transient"] as const;

export type FailureTag = (typeof FAILURE_TAGS)[number];

/**
 * Terminal failures per tag for one run.
 *
 * Counts rows that ended in failure, not attempts that failed. A row that hit
 * a 429, backed off, and succeeded is not a failure — it is the retry policy
 * working, and counting it would make `run.json` claim lost data that is
 * sitting right there in `verdicts`.
 */
export type FailureCounts = Record<FailureTag, number>;

export function emptyFailureCounts(): FailureCounts {
  return { RateLimited: 0, SchemaInvalid: 0, Transient: 0 };
}

/**
 * Tags worth a second attempt, listed positively.
 *
 * Positively rather than as `_tag !== 'SchemaInvalid'`: a fourth tag added
 * later must opt *in* to spending our rate limit. The negative form would
 * enrol it silently, which is the failure this whole policy exists to avoid.
 */
const RETRYABLE_TAGS = new Set<FailureTag>(["RateLimited", "Transient"]);

export function isRetryable(error: ClassifyError): boolean {
  return RETRYABLE_TAGS.has(error._tag);
}

/** `retry-after` in seconds. The header may also carry an HTTP date; we ignore those. */
function retryAfterSeconds(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"];
  if (raw === undefined) return undefined;

  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Put a thrown cause into the taxonomy.
 *
 * The retryable/deterministic split is taken from `APICallError.isRetryable`
 * rather than a status-code list of our own. The provider SDK already encodes
 * which of its statuses are worth trying again, and duplicating that as
 * `status >= 500 || status === 429` here would be a second copy to drift.
 */
export function classifyCause(responseId: string, cause: unknown): ClassifyError {
  if (NoObjectGeneratedError.isInstance(cause) || TypeValidationError.isInstance(cause)) {
    return new SchemaInvalid({ responseId });
  }

  if (APICallError.isInstance(cause)) {
    if (cause.statusCode === 429) {
      const retryAfter = retryAfterSeconds(cause.responseHeaders);
      // `exactOptionalPropertyTypes` — an absent header must omit the field
      // rather than set it to `undefined`.
      return retryAfter === undefined ? new RateLimited({}) : new RateLimited({ retryAfter });
    }

    return cause.isRetryable
      ? new Transient({ status: cause.statusCode ?? 0 })
      : new SchemaInvalid({ responseId });
  }

  return new Transient({ status: 0 });
}
