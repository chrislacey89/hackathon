import { Effect } from "effect";
import { loadConfig } from "../config/load";
import { writeRun } from "./emit";
import { loadResponses } from "./ingest";
import { sweep } from "./sweep";

/**
 * Run the full export and write `run.json`.
 *
 * This is the expensive half of the demo and the only thing that calls the
 * model. It is deliberately separate from `pnpm eval`, which scores an already
 * -written run: re-scoring must never require re-classifying, or every metric
 * costs 384 API calls to reproduce.
 *
 * `SWEEP_CONCURRENCY` overrides the config value. The config default is set
 * from the AI Studio dashboard; the env var exists so a demo run can be tuned
 * without editing committed config.
 */

const EXPORT_PATH = "data/volunteer_survey_export.csv";

const concurrency = process.env.SWEEP_CONCURRENCY
  ? Number(process.env.SWEEP_CONCURRENCY)
  : undefined;

const program = Effect.gen(function* () {
  const config = yield* loadConfig();
  const responses = yield* loadResponses(EXPORT_PATH);

  console.log(
    `sweeping ${responses.length} responses at concurrency ${concurrency ?? config.concurrency}`,
  );
  const startedAt = Date.now();

  const result = yield* sweep(responses, config, {
    ...(concurrency === undefined ? {} : { concurrency }),
    onProgress: (done, total) => {
      // Every 25 rows — enough to see it moving, not enough to flood a log.
      if (done % 25 === 0 || done === total) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  ${done}/${total}  (${elapsed}s)`);
      }
    },
  });

  yield* writeRun(result.leads, {
    generatedAt: new Date().toISOString(),
    config,
    partial: result.partial,
  });

  return result;
});

Effect.runPromise(program).then(
  (result) => {
    const routed = result.leads.filter((l) => l.signal !== "none").length;
    const failed = Object.values(result.failures).reduce((a, b) => a + b, 0);
    console.log(
      `\ndone — ${result.leads.length}/${result.attempted} classified, ${routed} carrying signal, ${failed} failed${
        failed > 0 ? ` (${JSON.stringify(result.failures)})` : ""
      }`,
    );
    if (result.partial) {
      console.log("run.json is marked partial: true");
    }
    console.log("next: pnpm eval");
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
