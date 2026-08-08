import { Effect } from "effect";
import { loadConfig } from "../config/load";
import { aggregate } from "./aggregate";
import { classifyResponse } from "./classify";
import { resolveCounty } from "./county";
import { writeRun } from "./emit";
import { loadResponses } from "./ingest";
import { appendQuotes, extractQuotes, QUOTES_PATH } from "./quotes";
import { dispositionOf, route } from "./route";

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

  const verdicts = yield* classifyResponse(response, config.categories);
  const responseVerdict = aggregate(response.responseId, verdicts);
  const lead = route(responseVerdict, response, resolveCounty(response.school, config), config);

  // The quotes stream forks here rather than downstream of routing: it is a
  // library, not a handoff, so it reads the same classified sentences and goes
  // to a document instead of to a recipient (issue #18). Running it on the
  // tracer's single response is what proves the second half of the fork works
  // end to end; the document only becomes useful once #4's sweep classifies
  // the whole export.
  //
  // Unaffected by #14's county routing: quotes go to a document, not a
  // recipient, so a response whose school is unmapped still yields its quote.
  const quotes = yield* appendQuotes(QUOTES_PATH, extractQuotes([response], [responseVerdict]));

  yield* writeRun([lead], {
    generatedAt: new Date().toISOString(),
    config,
    // One response is not the export. A tracer run that rendered as complete
    // would be the exact failure `partial` exists to prevent.
    partial: true,
  });

  return { lead, quotes };
});

/**
 * `Effect.runPromise` is the boundary. Nothing downstream of `run.json` — and
 * nothing in the Next.js app — touches Effect.
 */
Effect.runPromise(program).then(
  ({ lead, quotes }) => {
    const recipients = lead.recipientIds.length > 0 ? lead.recipientIds.join(", ") : "nobody";
    console.log(
      `${lead.responseId}: ${lead.signal} / ${lead.engagementType ?? "no category"}` +
        ` in ${lead.county ?? "no county"} (${lead.school})` +
        ` -> ${lead.teamId ?? dispositionOf(lead)} (${recipients})`,
    );
    console.log(`  quote: ${lead.quote ?? "(none)"} [${lead.sourceColumn ?? "-"}]`);
    // Zero is a correct answer on a re-run — the document already holds them.
    console.log(`  quotes added to ${QUOTES_PATH}: ${quotes.length}`);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
