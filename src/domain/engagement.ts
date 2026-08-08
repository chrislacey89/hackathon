import { z } from "zod";

/**
 * The project's shared vocabulary: the three free-text columns we read, and the
 * two enumerated schemes every downstream module agrees on.
 *
 * These live in one place because `segment`, `classify`, `aggregate`, and
 * `route` all speak them, and a second definition drifting from the first is
 * exactly the failure the boundary maps exist to prevent. The modules named in
 * issue #2's boundary map re-export the members they own, so a consumer can
 * import from either the module it was promised or from here.
 */

/**
 * Every free-text column the pipeline reads. `q6` is on this list because
 * roughly 5% of forward-looking intent is buried in "what could improve" — a
 * tool that only reads the last box misses those by construction.
 */
export const FREE_TEXT_COLUMNS = [
  "q5_what_went_well",
  "q6_what_could_improve",
  "q7_anything_else",
] as const;

export type FreeTextColumn = (typeof FREE_TEXT_COLUMNS)[number];

export const ENGAGEMENT_SIGNALS = ["strong", "soft", "none"] as const;

export type EngagementSignal = (typeof ENGAGEMENT_SIGNALS)[number];

/**
 * The id of one of JA's engagement categories.
 *
 * `string`, not a union — and that is the point rather than a compromise. The
 * member set lives in `config/categories.json` because Karen's list is
 * provisional and her definitive one is meant to be a data change (PRD #1
 * §Rabbit Holes, #24 §2). A union sourced from that file would be pinned to
 * whatever it said at build time, which is the hardcoded enum wearing a
 * different hat.
 *
 * The alias is kept rather than collapsed to `string` at every call site so the
 * *intent* of a field survives: `engagementType: EngagementType` says "a member
 * of the loaded taxonomy" where `engagementType: string` says nothing.
 *
 * What compile-time totality bought is replaced by three runtime checks, at the
 * three places a wrong value can actually enter — `classify` builds its schema's
 * enum from the loaded categories, `loadConfig` rejects a routing row naming an
 * unknown one, and `parseRun` rejects a lead citing a category its own run does
 * not carry. See the boundary-map correction comment on #14.
 */
export type EngagementType = string;

/**
 * Signal strength as an order, so "the strongest sentence wins" is a comparison
 * rather than a chain of ifs. Not a public ranking — `score` (slice #6) owns
 * priority, and it reads config weights, not this table.
 *
 * `as const satisfies` rather than a `Record` annotation: the annotation would
 * widen the values to `number`, while `satisfies` checks totality over
 * `EngagementSignal` *and* keeps the literals, so a missing member is a compile
 * error and the ranks stay readable at the call site.
 */
export const SIGNAL_RANK = {
  none: 0,
  soft: 1,
  strong: 2,
} as const satisfies Record<EngagementSignal, number>;

/**
 * One sentence's verdict, as the model returns it.
 *
 * This lives in the shared vocabulary rather than in `classify.ts` because two
 * very different modules need it and neither should import the other:
 * `classify` sends it to Gemini, and `run-file` validates it coming back off
 * disk in a Next.js app that must not load the AI SDK. It was previously
 * declared in both places, and the copies had already drifted — the `run.json`
 * copy had lost the `0..1` bound on `confidence` and the integer bound on
 * `sentenceIndex`, so a verdict rejected at the model boundary would have been
 * accepted on read-back.
 *
 * `engagementType` is a **nullable enum, not a union**. The natural modelling
 * — `{ signal: 'none' } | { signal: 'strong', engagementType: … }` — is
 * inexpressible here: `@ai-sdk/google` converts Zod to an OpenAPI 3.0 subset
 * that supports neither `z.union` nor `z.record` (research artifact, verified
 * against the provider docs 2026-08-08). Gemini's own `responseSchema` does
 * support `anyOf`; the narrowing is the SDK's.
 *
 * The tempting workaround — `structuredOutputs: false` — is a trap: it buys
 * the union by discarding schema enforcement on *every* call. So the schema
 * stays flat, `structuredOutputs` stays at its `true` default, and the
 * signal/type invariant is enforced in code after parsing (`aggregate`).
 *
 * `engagementType` is `z.string()` here rather than an enum because the member
 * set is config-sourced (see `EngagementType`). This schema is the *read-back*
 * shape — what a verdict looks like coming off disk in `run.json`. The
 * *outbound* shape, the one Gemini is actually constrained by, is built by
 * `sentenceVerdictSchemaFor` from the categories the run loaded.
 */
export const SentenceVerdictSchema = z.object({
  column: z.enum(FREE_TEXT_COLUMNS),
  sentenceIndex: z.number().int().min(0),
  quote: z.string(),
  signal: z.enum(ENGAGEMENT_SIGNALS),
  engagementType: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  serviceRecovery: z.boolean(),
});

export type SentenceVerdict = z.infer<typeof SentenceVerdictSchema>;

/**
 * The verdict schema with `engagementType` closed over the categories this run
 * actually loaded.
 *
 * Derived from `SentenceVerdictSchema` rather than declared beside it, so the
 * two cannot drift — the drift that had already happened between the two
 * hand-written `SentenceVerdict` declarations this module exists to have merged.
 * The closed enum is what stops Gemini inventing a category: without it the
 * structured-output contract would accept any string, and an invented category
 * would route to nobody and surface as a config gap that is not one.
 */
export function sentenceVerdictSchemaFor(categoryIds: readonly string[]) {
  return SentenceVerdictSchema.extend({
    engagementType: z.enum(categoryIds as [string, ...string[]]).nullable(),
  });
}

/**
 * A sentence verdict whose signal and type agree — the only shape that counts
 * as evidence of intent.
 *
 * Named here so `aggregate`'s type predicate can hand the compiler the half of
 * the invariant that is expressible. The schema cannot carry it (see above), so
 * this is where `signal !== 'none' implies engagementType !== null` stops being
 * purely a runtime claim.
 */
export type IntentVerdict = SentenceVerdict & {
  signal: Exclude<EngagementSignal, "none">;
  engagementType: EngagementType;
};
