import { z } from "zod";
import {
  ENGAGEMENT_SIGNALS,
  ENGAGEMENT_TYPES,
  FREE_TEXT_COLUMNS,
  SentenceVerdictSchema,
} from "../domain/engagement";
import type { EvalReport } from "../eval/evaluate";
import type { RoutedLead } from "../pipeline/route";

/**
 * The shape of `run.json`, and the seam between the pipeline and the app.
 *
 * This module is deliberately Effect-free. `run.json` is the *only* thing the
 * Next.js app reads from the pipeline, and PRD #1 §Implementation Decisions
 * keeps Effect out of the app entirely — so the type and its validator live
 * here, importing nothing but Zod, and both sides import this rather than each
 * other.
 */

const RoutedLeadSchema = z.object({
  responseId: z.string(),
  signal: z.enum(ENGAGEMENT_SIGNALS),
  engagementType: z.enum(ENGAGEMENT_TYPES).nullable(),
  engagementTypes: z.array(z.enum(ENGAGEMENT_TYPES)),
  confidence: z.number(),
  quote: z.string().nullable(),
  sourceColumn: z.enum(FREE_TEXT_COLUMNS).nullable(),
  serviceRecovery: z.boolean(),
  multiIntent: z.boolean(),
  // The one declaration, shared with the model boundary. Re-declaring it here
  // let the two drift: this copy had lost the 0..1 bound on `confidence`, so a
  // verdict rejected on the way out was accepted on the way back in.
  verdicts: z.array(SentenceVerdictSchema),
  teamId: z.string().nullable(),
  recipientIds: z.array(z.string()),
  name: z.string(),
  // Deliberately `z.string()`, not `z.email()` — unlike the recipient roster
  // below, this comes from JA's bulk survey export, which we do not control.
  // All 384 rows are well-formed today, but rejecting an entire run because one
  // volunteer's address is malformed would lose 383 good leads to save nobody
  // from anything. Contact data is displayed, not dispatched (§No-gos: nothing
  // is transmitted), so a bad address costs one un-clickable mailto.
  email: z.string(),
  employer: z.string(),
  program: z.string(),
});

export const RunCountsSchema = z.object({
  responses: z.number().int().min(0),
  routed: z.number().int().min(0),
  /** Routable leads reaching nobody. Non-zero means the routing table has a gap. */
  unowned: z.number().int().min(0),
  multiIntent: z.number().int().min(0),
  serviceRecovery: z.number().int().min(0),
});

/**
 * The roster is denormalised into the run rather than re-read from config by
 * the app. `recipientIds` on a lead is an id, and a queue headed "recipient-
 * program" helps nobody — but the app cannot call the Effect-based config
 * loader, and the demo is supposed to need nothing but this one file.
 */
const RunRecipientSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  role: z.string().optional(),
});

const RunTeamSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** True when this routing row is the builder's guess rather than JA's answer. */
  inferred: z.boolean(),
});

/**
 * Every field is required — `support` most of all.
 *
 * PRD #1 §SMART criteria: a rate is never published without its count. Marking
 * `support` optional here would let a run reach the app carrying a bare 0.87,
 * which is the exact shape the harness was built to refuse.
 */
const ClassMetricsSchema = z.object({
  className: z.string(),
  tp: z.number().int().min(0),
  fp: z.number().int().min(0),
  fn: z.number().int().min(0),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  support: z.number().int().min(0),
  unmeasurable: z.boolean(),
});

const EvalReportSchema = z.object({
  split: z.enum(["dev", "holdout"]),
  signal: z.array(ClassMetricsSchema),
  engagementType: z.array(ClassMetricsSchema),
  serviceRecovery: ClassMetricsSchema,
  baseline: z.object({ signal: z.array(ClassMetricsSchema) }),
  excluded: z.array(z.object({ responseId: z.string(), reason: z.string() })),
  totalLabeled: z.number().int().min(0),
});

const EvalRunSchema = z.object({
  dev: EvalReportSchema,
  holdout: EvalReportSchema,
});

export const RunFileSchema = z.object({
  generatedAt: z.string(),
  /** Which config file produced the routing — JA's, or the committed placeholders. */
  configSource: z.string(),
  recipients: z.array(RunRecipientSchema),
  teams: z.array(RunTeamSchema),
  /**
   * True when this run does not describe the whole export — a retry-exhausted
   * sweep, or the tracer's single response. A partial run must never render as
   * complete (PRD #1 §Implementation Decisions).
   */
  partial: z.boolean(),
  counts: RunCountsSchema,
  leads: z.array(RoutedLeadSchema),
  /**
   * How this run scored against the labeled sample, or `null` when it was
   * never scored.
   *
   * Nullable rather than optional, and nullable rather than absent, because
   * "not scored" has to be a statement the file makes rather than a field the
   * reader fails to find. The tracer classifies one response; scoring it
   * against 150 labels and publishing the result would be precisely the
   * confident wrong number this harness exists to prevent (issue #3). Populated
   * by `pnpm eval` once a run's predictions cover the labeled set.
   */
  eval: EvalRunSchema.nullable(),
});

export type RunCounts = z.infer<typeof RunCountsSchema>;
export type RunRecipient = z.infer<typeof RunRecipientSchema>;
export type RunTeam = z.infer<typeof RunTeamSchema>;

/**
 * `leads` is typed as `RoutedLead[]` rather than the schema's inferred type so
 * the app and the pipeline agree on one definition. The `satisfies` below is
 * the compile-time check that the validator has not drifted from it.
 */
export type EvalRun = { dev: EvalReport; holdout: EvalReport };

export type RunFile = Omit<z.infer<typeof RunFileSchema>, "leads" | "eval"> & {
  leads: RoutedLead[];
  eval: EvalRun | null;
};

/**
 * Compile-time assignability assertion. Fully erased — no runtime binding, no
 * double cast — and errors if the validator and `RoutedLead` ever disagree,
 * which is what licenses the one cast in `parseRun` below.
 */
type AssertAssignable<A extends B, B> = [A, B] extends [B, A] ? true : never;
type _LeadShapesAgree = AssertAssignable<z.infer<typeof RoutedLeadSchema>, RoutedLead>;
/**
 * The same check for the eval report. `EvalReport` is owned by `src/eval`, and
 * a field added there but not here would validate away silently on read-back —
 * the drift that had already happened between the two `SentenceVerdict`
 * declarations before they were merged.
 */
type _EvalShapesAgree = AssertAssignable<z.infer<typeof EvalReportSchema>, EvalReport>;

export class RunFileError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    const summary = issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    super(`run.json does not match the expected shape — ${summary}`);
    this.name = "RunFileError";
    this.issues = issues;
  }
}

/**
 * Validate a run read off disk.
 *
 * `safeParse` rather than `parse`, so the failure arrives as a `RunFileError`
 * naming the offending path instead of a raw `ZodError` rendered into a Next
 * error overlay. It still throws rather than returning a result: `run.json` is
 * an artifact this repo generates and commits, so a malformed one is a build
 * problem to fix, not a state the UI should have a branch for. The value here
 * is a legible message, not a recovery path.
 */
export function parseRun(raw: unknown): RunFile {
  const result = RunFileSchema.safeParse(raw);
  if (!result.success) throw new RunFileError(result.error.issues);
  return result.data as RunFile;
}
