import { google } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { Data, Effect } from "effect";
import { z } from "zod";
import {
  type EngagementSignal,
  type EngagementType,
  type SentenceVerdict,
  SentenceVerdictSchema,
} from "../domain/engagement";
import type { SurveyResponse } from "./ingest";
import { type Sentence, segmentResponse } from "./segment";

/**
 * Re-exported so this module still satisfies issue #2's boundary map, which
 * declares `classify.ts → SentenceVerdict`. The declaration now lives in the
 * shared vocabulary, because `run-file.ts` needs the same schema and must not
 * pull the AI SDK into the Next.js bundle to get it.
 */
export type { EngagementSignal, EngagementType, SentenceVerdict };
export { SentenceVerdictSchema };

const ClassificationSchema = z.object({
  verdicts: z.array(SentenceVerdictSchema),
});

/**
 * Failure of a single classification call.
 *
 * Deliberately one tag for the tracer. Slice #4 owns the real taxonomy
 * (`RateLimited` / `SchemaInvalid` / `Transient` in `src/pipeline/errors.ts`),
 * because the taxonomy only earns its keep once there is a retry predicate to
 * discriminate on and a sweep to count into. One call has neither.
 */
export class ClassifyError extends Data.TaggedError("ClassifyError")<{
  readonly responseId: string;
  readonly reason: string;
}> {}

/** Non-preview Flash, per the research artifact. Overridable for A/B against a Pro tier. */
export const DEFAULT_MODEL = "gemini-3.6-flash";

export type ClassifyOptions = {
  /** Model id to classify with. Pin a non-preview id for anything committed. */
  model?: string;
};

/**
 * Instructions are held apart from the response text and emitted first so the
 * prompt prefix is byte-identical across all 384 calls — the precondition for
 * Gemini's implicit prefix caching to engage at all.
 */
const INSTRUCTIONS = `You are classifying volunteer survey free-text for Junior Achievement.

Your job is to find FORWARD-LOOKING INTENT: a statement about doing something next.
Enthusiasm is not intent. "I loved it" and "best volunteer experience I've had" are
praise about the past and are NOT intent. "Sign me up for spring", "put me down for
next fall", "happy to speak again" ARE intent.

For EVERY sentence listed below, emit exactly one verdict, in the order given.

signal:
- "strong": an explicit, unconditional offer or commitment to do something next.
- "soft": a conditional, hedged, or vague future statement ("maybe in the spring",
  "if you're ever short someone", "reach out in a few months").
- "none": no forward-looking intent. Praise, complaints, logistics, and social
  formulas ("happy to help", "let me know", "anytime", "thanks for everything")
  are "none" unless they name a specific future action.

engagementType (null when signal is "none", otherwise the best fit):
- volunteer_again: return to volunteer in a similar capacity
- speaking: present, speak on a panel, share their career
- refer_colleague: bring or refer another person
- committee_board: join a committee or board
- corporate_sponsorship: involve their employer as a sponsor or partner
- donation: give money or goods

serviceRecovery: true when the sentence reports a bad experience JA should follow
up on to repair. Independent of signal — a complaint can also carry intent.

confidence: 0 to 1, your confidence in this sentence's signal.
quote: the sentence text, verbatim.

Bias toward recall on signal: a missed offer loses a volunteer JA already
recruited, while an extra flag costs one awkward email.`;

function buildPrompt(response: SurveyResponse, sentences: Sentence[]): string {
  const listed = sentences.map((s) => `[${s.column} #${s.index}] ${s.text}`).join("\n");

  return `${INSTRUCTIONS}

--- RESPONSE ${response.responseId} ---
Program: ${response.program}
Role this year: ${response.roleThisYear}

Sentences to classify:
${listed}`;
}

/**
 * Drop verdicts that do not address a sentence we actually sent.
 *
 * A hallucinated `(column, sentenceIndex)` pair would attach a quote to the
 * wrong question in the queue UI, which is worse than no lead at all — the
 * citation is the thing a staffer trusts instead of opening the raw export.
 */
function keepAddressable(verdicts: SentenceVerdict[], sentences: Sentence[]): SentenceVerdict[] {
  const addressable = new Set(sentences.map((s) => `${s.column}#${s.index}`));
  return verdicts.filter((v) => addressable.has(`${v.column}#${v.sentenceIndex}`));
}

/**
 * Classify one response's free text, sentence by sentence.
 *
 * One call per *response*, not per sentence: 384 calls instead of ~1,000+,
 * while still producing sentence-level verdicts. It also gives the model
 * whole-response context, which is what lets it read "More prep time would
 * help. That said, put me down for next fall." as an offer wrapped in a
 * complaint rather than as two unrelated fragments.
 *
 * `generateText` + `Output.object`. The older single-purpose object-generation
 * helper this replaces was deprecated in AI SDK v6 with removal pending, and
 * is banned project-wide (research artifact, migration guides 6.0/7.0).
 *
 * A response with no free text short-circuits to `[]` without a network call.
 */
export function classifyResponse(
  response: SurveyResponse,
  options: ClassifyOptions = {},
): Effect.Effect<SentenceVerdict[], ClassifyError> {
  const sentences = segmentResponse(response);
  if (sentences.length === 0) return Effect.succeed([]);

  return Effect.tryPromise({
    try: () =>
      generateText({
        model: google(options.model ?? DEFAULT_MODEL),
        output: Output.object({ schema: ClassificationSchema }),
        providerOptions: { google: { thinkingLevel: "low" } },
        prompt: buildPrompt(response, sentences),
      }),
    catch: (cause) => new ClassifyError({ responseId: response.responseId, reason: String(cause) }),
  }).pipe(Effect.map((result) => keepAddressable(result.output.verdicts, sentences)));
}
