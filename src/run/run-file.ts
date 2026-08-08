import { z } from "zod";
import { ENGAGEMENT_SIGNALS, ENGAGEMENT_TYPES, FREE_TEXT_COLUMNS } from "../domain/engagement";
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
  verdicts: z.array(
    z.object({
      column: z.enum(FREE_TEXT_COLUMNS),
      sentenceIndex: z.number(),
      quote: z.string(),
      signal: z.enum(ENGAGEMENT_SIGNALS),
      engagementType: z.enum(ENGAGEMENT_TYPES).nullable(),
      confidence: z.number(),
      serviceRecovery: z.boolean(),
    }),
  ),
  teamId: z.string().nullable(),
  recipientIds: z.array(z.string()),
  name: z.string(),
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
  email: z.string(),
  role: z.string().optional(),
});

const RunTeamSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** True when this routing row is the builder's guess rather than JA's answer. */
  inferred: z.boolean(),
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
});

export type RunCounts = z.infer<typeof RunCountsSchema>;
export type RunRecipient = z.infer<typeof RunRecipientSchema>;
export type RunTeam = z.infer<typeof RunTeamSchema>;

/**
 * `leads` is typed as `RoutedLead[]` rather than the schema's inferred type so
 * the app and the pipeline agree on one definition. The `satisfies` below is
 * the compile-time check that the validator has not drifted from it.
 */
export type RunFile = Omit<z.infer<typeof RunFileSchema>, "leads"> & {
  leads: RoutedLead[];
};

type SchemaLead = z.infer<typeof RoutedLeadSchema>;
const _leadShapesAgree = null as unknown as SchemaLead satisfies RoutedLead;

export function parseRun(raw: unknown): RunFile {
  return RunFileSchema.parse(raw) as RunFile;
}
