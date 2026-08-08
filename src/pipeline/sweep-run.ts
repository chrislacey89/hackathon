import { Effect } from "effect";
import { loadConfig } from "../config/load";
import { FAILURE_TAGS } from "../domain/failure";
import { writeRun } from "./emit";
import { loadResponses } from "./ingest";
import { routeAll } from "./route";
import { sweep } from "./sweep";

/**
 * The full sweep: every row of the export, through the model, into `run.json`.
 *
 * The tracer proved one response could make the round trip. This runs the same
 * spine over all of them under the reliability policy slice #4 exists for —
 * bounded concurrency, retry only where a retry can help, and a failure tally
 * that makes a lossy run say so.
 *
 * Deliberately the *only* place `Effect.runPromise` appears alongside the whole
 * pipeline. Everything above it is an Effect; everything below `run.json` — the
 * Next.js app included — is plain (PRD #1 §Implementation Decisions).
 */

const EXPORT_PATH = "data/volunteer_survey_export.csv";

const program = Effect.gen(function* () {
  const config = yield* loadConfig();
  const responses = yield* loadResponses(EXPORT_PATH);

  const result = yield* sweep(responses, config);
  const leads = routeAll(responses, result.verdicts, config);

  yield* writeRun(leads, {
    generatedAt: new Date().toISOString(),
    config,
    failures: result.failures,
    // Straight from the sweep rather than recomputed here. `partial` is the
    // claim that this run does not describe the whole export, and the only
    // thing that knows is the code that watched the rows fail.
    partial: result.partial,
  });

  return { result, leads };
});

Effect.runPromise(program).then(
  ({ result, leads }) => {
    const routed = leads.filter((lead) => lead.signal !== "none").length;
    console.log(
      `${result.verdicts.length} of ${result.attempted} responses classified — ${routed} routable`,
    );

    const lost = FAILURE_TAGS.filter((tag) => result.failures[tag] > 0)
      .map((tag) => `${result.failures[tag]} ${tag}`)
      .join(", ");

    // A partial run has to announce itself here as well as in run.json. An
    // operator watching a weekly cron read the last line of output, not the
    // artifact, and silence is what makes a lossy week look like a quiet one.
    console.log(lost === "" ? "no failures — run is complete" : `PARTIAL RUN — lost ${lost}`);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
