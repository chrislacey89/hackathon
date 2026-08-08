import { Effect } from "effect";
import { loadConfig } from "../config/load";
import { aggregate } from "./aggregate";
import { classifyResponse } from "./classify";
import { writeRun } from "./emit";
import { loadResponses } from "./ingest";
import { route } from "./route";

/**
 * The tracer bullet: one response through every layer, end to end.
 *
 * config -> ingest -> segment -> classify (one real Gemini call) -> aggregate
 * -> route -> run.json, which the Next.js app then renders. It exists to prove
 * the four things most likely to be wrong before any other slice commits to
 * them, not to be useful: that the flat schema round-trips through
 * @ai-sdk/google, that Effect wraps the promise-based AI SDK cleanly, that
 * Next reads the cached run without Effect crossing the boundary, and that the
 * lint and hook gates pass on this layout.
 *
 * Slice #4 replaces the single call with the bounded-concurrency sweep over
 * all 384 rows.
 */

const EXPORT_PATH = "data/volunteer_survey_export.csv";

/**
 * JA-24378. The planted case: intent buried in "what could improve", wrapped
 * in a complaint. If the spine works on this row it works on the easy ones.
 */
const TRACER_RESPONSE_ID = "JA-24378";

const program = Effect.gen(function* () {
  const config = yield* loadConfig();
  const responses = yield* loadResponses(EXPORT_PATH);

  const response = responses.find((r) => r.responseId === TRACER_RESPONSE_ID);
  if (response === undefined) {
    return yield* Effect.dieMessage(`${TRACER_RESPONSE_ID} is not in ${EXPORT_PATH}`);
  }

  const verdicts = yield* classifyResponse(response);
  const lead = route(aggregate(response.responseId, verdicts), response, config);

  yield* writeRun([lead], {
    generatedAt: new Date().toISOString(),
    config,
    // One response is not the export. A tracer run that rendered as complete
    // would be the exact failure `partial` exists to prevent.
    partial: true,
  });

  return lead;
});

/**
 * `Effect.runPromise` is the boundary. Nothing downstream of `run.json` — and
 * nothing in the Next.js app — touches Effect.
 */
Effect.runPromise(program).then(
  (lead) => {
    const recipients = lead.recipientIds.length > 0 ? lead.recipientIds.join(", ") : "nobody";
    console.log(
      `${lead.responseId}: ${lead.signal} / ${lead.engagementType ?? "no type"} -> ${
        lead.teamId ?? "unowned"
      } (${recipients})`,
    );
    console.log(`  quote: ${lead.quote ?? "(none)"} [${lead.sourceColumn ?? "-"}]`);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
