import { google } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import {
  type EngagementSignal,
  type EngagementType,
  type SentenceVerdict,
  SentenceVerdictSchema,
} from "../domain/engagement";
import { type ClassifyError, classifyCause } from "./errors";
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
 * The tracer's single `ClassifyError` tag is gone: the taxonomy it deferred to
 * slice #4 now exists in `./errors`, and the retry predicate that discriminates
 * on it is what makes the distinction pay. Re-exported here so callers keep
 * importing their error type from the module that produces it.
 */
export type { ClassifyError };

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

quotable: true when this sentence could be quoted in a grant application or a
marketing piece as a volunteer's testimonial, attributed to them by name.
JA's number-one need is quality quotes.
- Judge this INDEPENDENTLY of signal. A sentence with no forward-looking intent
  at all is often the best quote in the survey, and an offer to volunteer again
  is usually not quotable.
- Quotable: a positive statement about the experience, the students, or the
  programme that reads well on its own — "Best volunteer experience I've had in
  years", "The kids were so engaged the entire time", "The staff were amazing
  and the students were a joy to work with", "Watching a student realise she
  could run a business made my year". Vividness is a bonus, not a requirement.
- Not quotable: content-free replies ("Fine", "Good", "n/a", "Nothing to add"),
  logistics, complaints, sentences about JA's internal process rather than the
  experience, and anything that only makes sense beside the question it answers
  ("More time with the students"). Never invent or tidy the wording.
- Most sentences are not quotable, but a survey this size should yield real
  ones. When several sentences in a response say the same thing, mark the
  strongest and leave the rest false.

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

export type CitationPartition = {
  /** Verdicts citing a sentence we actually sent. */
  addressable: SentenceVerdict[];
  /** Verdicts citing a sentence that does not exist. Never reaches a queue. */
  unaddressable: SentenceVerdict[];
};

/**
 * Split model output by whether each verdict cites a sentence we actually sent.
 *
 * This is the guard between a hallucinating model and the citation a JA staffer
 * trusts instead of opening the raw export. A verdict claiming
 * `q6_what_could_improve #0` when q6 was blank would attach a real quote to the
 * wrong survey question — worse than no lead at all, because the lead still
 * looks credible.
 *
 * Exported, and returning both halves rather than filtering in place, for two
 * reasons. It is the only part of `classify` that is pure and therefore the
 * only part testable without a live call — and the discards are a reliability
 * fact, not noise: slice #4 counts failures by tag for `run.json`, and this is
 * the tag it will need. Returning them now means #4 reads this function rather
 * than rewriting it.
 *
 * Matching is on the `(column, index)` pair, never the index alone. The two
 * are separately plausible — index 2 exists in q7 while q5 has only one
 * sentence — so a cross-column citation is exactly the confusion a
 * single-axis check would wave through.
 */
export function partitionByCitation(
  verdicts: SentenceVerdict[],
  sentences: Sentence[],
): CitationPartition {
  const sent = new Set(sentences.map((s) => `${s.column}#${s.index}`));
  const addressable: SentenceVerdict[] = [];
  const unaddressable: SentenceVerdict[] = [];

  for (const verdict of verdicts) {
    const bucket = sent.has(`${verdict.column}#${verdict.sentenceIndex}`)
      ? addressable
      : unaddressable;
    bucket.push(verdict);
  }

  return { addressable, unaddressable };
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
    // The cause is put into the taxonomy *here*, at the only point that still
    // holds the provider's own error object — its status code and its
    // `retry-after` header. Stringifying it first and re-deriving the class
    // downstream would mean parsing our own error message.
    catch: (cause) => classifyCause(response.responseId, cause),
  }).pipe(
    Effect.flatMap((result) => {
      const { addressable, unaddressable } = partitionByCitation(result.output.verdicts, sentences);

      // Both discards were previously silent. Each is rare and benign when it
      // fires once, and a signal that the prompt or the segmentation has
      // drifted when it fires often — which nobody can notice if it never says
      // anything. Slice #4 turns these into counted tags in run.json.
      const warnings: string[] = [];
      if (unaddressable.length > 0) {
        warnings.push(
          `dropped ${unaddressable.length} verdict(s) citing a sentence that was not sent`,
        );
      }

      // `quotable: null` from a live call means the model declined to judge,
      // which `extractQuotes` reads as "no quote". Left silent, a prompt or
      // provider change that stopped eliciting the field would present as an
      // empty quotes document — indistinguishable from an export with nothing
      // worth quoting in it, and Karen's top need failing quietly.
      const unjudged = addressable.filter((v) => v.quotable === null).length;
      if (unjudged > 0) {
        warnings.push(`${unjudged} verdict(s) came back with no quotability judgement`);
      }

      return warnings.length === 0
        ? Effect.succeed(addressable)
        : Effect.logWarning(`${response.responseId}: ${warnings.join("; ")}`).pipe(
            Effect.as(addressable),
          );
    }),
  );
}
