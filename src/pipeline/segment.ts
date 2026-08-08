import { FREE_TEXT_COLUMNS, type FreeTextColumn } from "../domain/engagement";
import type { SurveyResponse } from "./ingest";

export type { FreeTextColumn };
export { FREE_TEXT_COLUMNS };

/**
 * One sentence of free text, addressable by where it came from.
 *
 * `column` and `index` together are the citation a JA staffer sees beside a
 * lead — "they said this, in the 'what could improve' box" — which is what
 * makes a lead judgeable in two seconds without opening the raw export.
 */
export type Sentence = {
  responseId: string;
  column: FreeTextColumn;
  index: number;
  text: string;
};

/**
 * The `SurveyResponse` fields that actually hold prose.
 *
 * Derived from `SurveyResponse` rather than written out, so the map below
 * cannot point a column at `q1OverallSatisfaction`. `keyof SurveyResponse`
 * would permit exactly that, which is why the loop previously needed a
 * `typeof prose !== "string"` guard to compensate for a type wider than
 * reality.
 */
type FreeTextField = {
  [K in keyof SurveyResponse]: SurveyResponse[K] extends string | null ? K : never;
}[keyof SurveyResponse];

/** Column identifier → the `SurveyResponse` field holding its prose. */
const COLUMN_FIELDS = {
  q5_what_went_well: "q5WhatWentWell",
  q6_what_could_improve: "q6WhatCouldImprove",
  q7_anything_else: "q7AnythingElse",
} as const satisfies Record<FreeTextColumn, FreeTextField>;

/**
 * `Intl.Segmenter` is the sentence splitter — ICU's Unicode segmentation
 * algorithm, shipped with Node, rather than a regex.
 *
 * PRD #1 §Rabbit Holes calls sentence splitting fiddly and upstream of
 * everything, and says to use a library and never hand-roll on regex alone.
 * This is that library; it also costs no dependency and no supply chain.
 *
 * Known limitation, accepted deliberately: ICU breaks after an abbreviation's
 * period ("Dr. Smith" splits in two). The cost is bounded here because
 * classification is batched by *response* — the model sees the whole response
 * as context regardless of how it was split — and because a split sentence
 * still cites the correct column. Revisit only if quotes start reading
 * truncated in the queue UI.
 */
const SEGMENTER = new Intl.Segmenter("en", { granularity: "sentence" });

function splitSentences(prose: string): string[] {
  return [...SEGMENTER.segment(prose)]
    .map((segment) => segment.segment.trim())
    .filter((text) => text.length > 0);
}

/**
 * Split every free-text column of one response into cited sentences.
 *
 * Pure and total: no I/O, no model, and a response with nothing written in it
 * yields an empty array rather than an error. Indices restart per column so a
 * verdict's `(column, index)` pair addresses the same sentence no matter which
 * other columns the volunteer filled in.
 */
export function segmentResponse(response: SurveyResponse): Sentence[] {
  const sentences: Sentence[] = [];

  for (const column of FREE_TEXT_COLUMNS) {
    const prose = response[COLUMN_FIELDS[column]];
    if (prose === null) continue;

    splitSentences(prose).forEach((text, index) => {
      sentences.push({ responseId: response.responseId, column, index, text });
    });
  }

  return sentences;
}
