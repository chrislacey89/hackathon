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

export const ENGAGEMENT_TYPES = [
  "volunteer_again",
  "committee_board",
  "corporate_sponsorship",
  "refer_colleague",
  "speaking",
  "donation",
] as const;

export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

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
 */
export const SentenceVerdictSchema = z.object({
  column: z.enum(FREE_TEXT_COLUMNS),
  sentenceIndex: z.number().int().min(0),
  quote: z.string(),
  signal: z.enum(ENGAGEMENT_SIGNALS),
  engagementType: z.enum(ENGAGEMENT_TYPES).nullable(),
  confidence: z.number().min(0).max(1),
  serviceRecovery: z.boolean(),
  /**
   * Whether this sentence is worth putting in front of the grants team.
   *
   * A **separate judgement from `signal`**, deliberately, and the one Karen
   * ranked first: "finding quality quotes that we can use for grant and
   * marketing purposes." A volunteer with no forward-looking intent at all can
   * write the best line in the export, so nothing downstream may infer
   * quotability from signal, or the other way round.
   *
   * Nullable, and `null` means **not judged** — not "judged and rejected".
   * Two producers legitimately have no opinion: `run.json` artifacts written
   * before this field existed, and the keyword baseline in `src/eval`, which
   * scores signal only. Making absence an explicit state keeps a model that
   * declined to answer distinguishable from one that answered no, which is the
   * difference between "the quotes pass is broken" and "there were no quotes"
   * — indistinguishable under a `.default(false)`, and both render as an empty
   * document.
   */
  quotable: z.boolean().nullable(),
});

export type SentenceVerdict = z.infer<typeof SentenceVerdictSchema>;

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
