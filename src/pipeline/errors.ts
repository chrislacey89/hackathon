import {
  APICallError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoSuchModelError,
  TypeValidationError,
} from "ai";
import { Data } from "effect";
import type { FailureTag } from "../domain/failure";

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
 * The tag vocabulary and the per-run tally live in the shared domain, because
 * `run.json` carries the counts and the Next.js app must be able to read their
 * schema without importing `effect` or the AI SDK. Re-exported here so pipeline
 * code still has one import for "everything about failures".
 */
export {
  emptyFailureCounts,
  FAILURE_TAGS,
  type FailureCounts,
  type FailureTag,
} from "../domain/failure";

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
 * Errors that mean the run is misconfigured rather than unlucky.
 *
 * A missing key and an unknown model id are the two likeliest operator
 * mistakes, and neither is an `APICallError` — the request never reached the
 * provider. They therefore used to miss the `isRetryable` branch entirely and
 * land on the transient catch-all at the bottom, which is the most expensive
 * possible answer: four attempts per row, ~1,536 attempts across the export,
 * eleven minutes of backoff, and a final report blaming the network.
 *
 * They are listed here explicitly rather than folded into the catch-all,
 * because the catch-all's optimism is correct for what it is actually for —
 * socket resets and DNS blips, which do succeed on a second attempt.
 */
const DETERMINISTIC_SDK_ERRORS = [LoadAPIKeyError, NoSuchModelError] as const;

/**
 * Put a thrown cause into the taxonomy.
 *
 * The retryable/deterministic split is taken from `APICallError.isRetryable`
 * rather than a status-code list of our own. The provider SDK already encodes
 * which of its statuses are worth trying again, and duplicating that as
 * `status >= 500 || status === 429` here would be a second copy to drift.
 *
 * The ordering below is deliberate: every *known* deterministic shape is
 * matched first, and the optimistic `Transient` default is reached only by
 * causes we genuinely cannot identify.
 */
export function classifyCause(responseId: string, cause: unknown): ClassifyError {
  if (NoObjectGeneratedError.isInstance(cause) || TypeValidationError.isInstance(cause)) {
    return new SchemaInvalid({ responseId });
  }

  if (DETERMINISTIC_SDK_ERRORS.some((sdkError) => sdkError.isInstance(cause))) {
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
