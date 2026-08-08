import { z } from "zod";
import { ENGAGEMENT_SIGNALS, FREE_TEXT_COLUMNS, SentenceVerdictSchema } from "../domain/engagement";
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
  // `z.string()`, not an enum — the category set is config-sourced, so it is not
  // knowable at the time this schema is declared. It *is* knowable at the time a
  // run is read, because the run denormalises its own `categories`; the
  // cross-check in `checkCategoriesResolve` below is where the membership
  // guarantee the enum used to give is actually enforced.
  engagementType: z.string().nullable(),
  engagementTypes: z.array(z.string()),
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
  /** `null` exactly when `school` reached no row of the county lookup. */
  county: z.string().nullable(),
  school: z.string(),
  /** Middle field of the ledger key `(responseId, submittedAt, recipientId)`. */
  submittedAt: z.string(),
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
  /**
   * Routable leads whose school is in no county. Non-zero means the *lookup*
   * has a gap — a different repair from `unowned`, in a different file, so the
   * two are counted separately rather than summed into "not routed".
   */
  unmapped: z.number().int().min(0),
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
 * JA's engagement categories, denormalised into the run.
 *
 * Two jobs, both of which used to be done by a TypeScript union. It carries the
 * `label` the UI prints — previously `TYPE_LABELS satisfies Record<EngagementType,
 * string>` in `page.tsx`, which cannot exist once the member set is
 * runtime-sourced — and it is the list `checkCategoriesResolve` validates every
 * lead against. `inferred` is what the UI badges: PRD #1 requires anything JA
 * has not authored to say so.
 */
const RunCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  inferred: z.boolean(),
});

/**
 * The `school → county` lookup this run routed with.
 *
 * Denormalised for the same reason as the roster: the app cannot call the
 * Effect-based config loader, and the demo is supposed to need nothing but this
 * one file. `inferred` badges a county we derived from geography rather than one
 * JA supplied.
 */
const RunCountySchema = z.object({
  school: z.string(),
  county: z.string(),
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

const RunFileShape = z.object({
  generatedAt: z.string(),
  /** Which config files produced the routing — JA's, or the committed placeholders. */
  configSource: z.string(),
  recipients: z.array(RunRecipientSchema),
  teams: z.array(RunTeamSchema),
  categories: z.array(RunCategorySchema),
  counties: z.array(RunCountySchema),
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

/**
 * Every category a lead cites must be one this run carries.
 *
 * This is the read-back half of the guarantee `z.enum(ENGAGEMENT_TYPES)` used to
 * give for free, and it has to live here rather than in the field's schema
 * because the allowed set is a *sibling field* of the thing being validated —
 * not knowable until the same parse has read `categories`.
 *
 * Without it a run could name a category its own config does not define, and
 * the UI would print a raw id with no label beside a lead routed to nobody —
 * indistinguishable from a genuine routing gap.
 */
export const RunFileSchema = RunFileShape.superRefine((run, ctx) => {
  const known = new Set(run.categories.map((category) => category.id));

  for (const [index, lead] of run.leads.entries()) {
    const cited = [lead.engagementType, ...lead.engagementTypes].filter(
      (id): id is string => id !== null,
    );
    for (const id of cited) {
      if (!known.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["leads", index, "engagementType"],
          message: `lead ${lead.responseId} cites category "${id}", which this run does not carry`,
        });
      }
    }
  }
});

export type RunCounts = z.infer<typeof RunCountsSchema>;
export type RunRecipient = z.infer<typeof RunRecipientSchema>;
export type RunTeam = z.infer<typeof RunTeamSchema>;
export type RunCategory = z.infer<typeof RunCategorySchema>;
export type RunCounty = z.infer<typeof RunCountySchema>;

/**
 * `leads` is typed as `RoutedLead[]` rather than the schema's inferred type so
 * the app and the pipeline agree on one definition. The `satisfies` below is
 * the compile-time check that the validator has not drifted from it.
 */
export type EvalRun = { dev: EvalReport; holdout: EvalReport };

export type RunFile = Omit<z.infer<typeof RunFileShape>, "leads" | "eval"> & {
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

/**
 * Set `eval` on a run read off disk, preserving fields this schema does not
 * know about.
 *
 * The obvious spelling — `{ ...parseRun(raw), eval }` — is quietly destructive.
 * `RunFileSchema` is a strict `z.object`, so parsing *strips* every unknown key
 * (verified: an added `futureField` does not survive `parseRun`). That is the
 * behaviour the app wants, because it should not act on fields it cannot
 * validate. It is the wrong base for a write-back: `pnpm eval` would read a
 * run, drop everything the schema had not caught up with, and write the
 * remainder back over the committed artifact with no error and no signal.
 *
 * Slices #4, #15, and #19 each add fields to `run.json`. The first to land
 * would be deleted by the next eval run.
 *
 * The alternative considered and rejected was `z.looseObject` on
 * `RunFileShape`. It preserves unknown keys, but its inferred type carries an
 * index signature — `run.totallyMadeUpField` then compiles clean everywhere,
 * including in the Next.js app. That trades a latent write-back bug for a
 * permanent hole in the type the whole project reads runs through.
 *
 * Validates the result rather than the input, so a caller cannot write a run
 * that would fail to parse on the way back in.
 */
export function withEval(
  raw: Record<string, unknown>,
  value: EvalRun | null,
): Record<string, unknown> {
  const updated = { ...raw, eval: value };
  parseRun(updated);
  return updated;
}
