import { z } from "zod";

/**
 * The names of the ways a classification call can fail, and the shape of the
 * per-run tally.
 *
 * This lives in the shared vocabulary rather than in `pipeline/errors.ts` for
 * the same reason `SentenceVerdictSchema` does: `run.json` carries these counts,
 * so `run/run-file.ts` needs the schema, and that module is read by the Next.js
 * app. Importing it from `errors.ts` would drag `effect` and the AI SDK across
 * a boundary PRD #1 §Implementation Decisions keeps closed.
 *
 * The tagged error classes stay in `pipeline/errors.ts`, where they can depend
 * on both. Only the vocabulary moves.
 */

export const FAILURE_TAGS = ["RateLimited", "SchemaInvalid", "Transient"] as const;

export type FailureTag = (typeof FAILURE_TAGS)[number];

/**
 * Terminal failures per tag for one run.
 *
 * Counts rows that ended in failure, not attempts that failed. A row that hit a
 * 429, backed off, and succeeded is not a failure — it is the retry policy
 * working, and counting it would make `run.json` claim lost data that is
 * sitting right there in `verdicts`.
 */
export const FailureCountsSchema = z.object({
  /** The provider asked us to slow down and the row never got through. */
  RateLimited: z.number().int().min(0),
  /** A deterministic rejection — a malformed generation, or a refused request. */
  SchemaInvalid: z.number().int().min(0),
  /** A server or network failure that outlasted the retry budget. */
  Transient: z.number().int().min(0),
});

export type FailureCounts = z.infer<typeof FailureCountsSchema>;

/**
 * Compile-time check that the schema above covers exactly `FAILURE_TAGS`.
 *
 * The schema is spelled out rather than built from the array so it keeps its
 * inferred type and its per-tag documentation; this assertion is what stops the
 * two representations drifting. Adding a tag to `FAILURE_TAGS` without adding
 * a field here fails the build, which is the point.
 *
 * The check has to sit in a *constraint* to raise anything. A conditional type
 * that evaluates to `never` is a perfectly legal alias and errors nowhere, so
 * `Equals` computes the verdict and `Assert<T extends true>` is what fails the
 * build when it comes back `false`. Mutual `A extends B, B extends A` would be
 * the obvious spelling and is rejected as a circular constraint.
 *
 * Fully erased — no runtime binding.
 */
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type _TagsCovered = Assert<Equals<FailureTag, keyof FailureCounts>>;

export function emptyFailureCounts(): FailureCounts {
  return { RateLimited: 0, SchemaInvalid: 0, Transient: 0 };
}
