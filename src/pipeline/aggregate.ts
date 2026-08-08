import {
  type EngagementSignal,
  type EngagementType,
  type FreeTextColumn,
  type IntentVerdict,
  type SentenceVerdict,
  SIGNAL_RANK,
} from "../domain/engagement";

/**
 * One response's verdict, rolled up from its sentences.
 *
 * `engagementType` is the strongest sentence's type — what the lead is
 * primarily about. `engagementTypes` is *all* distinct types found, because a
 * volunteer offering both to speak and to introduce their employer is two
 * leads for two teams, and collapsing to one silently loses the other. Ground
 * truth carries a single type per response, so the eval cannot see that loss;
 * `multiIntent` exists to make its frequency visible anyway (PRD #1 §Error
 * Modes 3, §Rabbit Holes).
 */
export type ResponseVerdict = {
  responseId: string;
  signal: EngagementSignal;
  engagementType: EngagementType | null;
  engagementTypes: EngagementType[];
  confidence: number;
  quote: string | null;
  sourceColumn: FreeTextColumn | null;
  serviceRecovery: boolean;
  multiIntent: boolean;
  verdicts: SentenceVerdict[];
};

/**
 * A sentence verdict is usable as evidence of intent only when its signal and
 * its type agree.
 *
 * The schema cannot enforce this: it is flat by necessity (`@ai-sdk/google`
 * rejects `z.union`), so the model is free to return `none` with a type
 * attached, or `strong` with none. Both arrive looking well-formed.
 *
 * Discarding the contradiction rather than trusting either half is deliberate.
 * A `strong` with no type would route a typeless lead to whichever team the
 * fallback picked; a `none` with a type would put a team-less type into a
 * queue. Both corrupt silently instead of failing loudly, which is exactly the
 * property PRD #1 §Implementation Decisions names this invariant to prevent.
 */
function isCoherentIntent(v: SentenceVerdict): v is IntentVerdict {
  return v.signal !== "none" && v.engagementType !== null;
}

/** Strongest signal first; among equals, the model's own confidence decides. */
function strongerThan(a: SentenceVerdict, b: SentenceVerdict): boolean {
  const rankDelta = SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal];
  return rankDelta > 0 || (rankDelta === 0 && a.confidence > b.confidence);
}

/**
 * Roll a response's sentence verdicts into one response verdict.
 *
 * Pure and total: no I/O, no model, and every input — including an empty list
 * or a self-contradictory verdict — yields a well-formed result rather than an
 * error. The pipeline's job is to under-claim, not to crash.
 *
 * Takes `responseId` explicitly because `SentenceVerdict` deliberately does
 * not carry one: the model is asked to classify sentences, not to echo back an
 * identifier it could get wrong. The id belongs to the caller, which knows it
 * for certain.
 */
export function aggregate(responseId: string, verdicts: SentenceVerdict[]): ResponseVerdict {
  // `isCoherentIntent` is a type predicate, so `intents` is IntentVerdict[] —
  // the compiler now carries the non-null-ness the filter established, and
  // `engagementTypes` needs no second filter to recover it.
  const intents = verdicts.filter(isCoherentIntent);

  const strongest = intents.reduce<IntentVerdict | null>(
    (best, v) => (best === null || strongerThan(v, best) ? v : best),
    null,
  );

  const engagementTypes = [...new Set(intents.map((v) => v.engagementType))];

  const serviceRecovery = verdicts.some((v) => v.serviceRecovery);

  if (strongest === null) {
    return {
      responseId,
      signal: "none",
      engagementType: null,
      engagementTypes: [],
      confidence: 0,
      quote: null,
      sourceColumn: null,
      serviceRecovery,
      multiIntent: false,
      verdicts,
    };
  }

  return {
    responseId,
    signal: strongest.signal,
    engagementType: strongest.engagementType,
    engagementTypes,
    confidence: strongest.confidence,
    quote: strongest.quote,
    sourceColumn: strongest.column,
    serviceRecovery,
    multiIntent: engagementTypes.length > 1,
    verdicts,
  };
}
