import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { loadResponses } from "../pipeline/ingest";
import { RUN_PATH } from "../run/read";
import { type EvalRun, parseRun, withEval } from "../run/run-file";
import { keywordBaseline } from "./baseline";
import { type ClassMetrics, type EvalReport, evaluate } from "./evaluate";
import { loadGroundTruth } from "./ground-truth";
import { splitLabeled } from "./split";

/**
 * Score the committed run against the labeled sample and print the result.
 *
 * The harness's runnable face: `pnpm eval`. It calls no model — the keyword
 * baseline is computed here and the model's predictions are read out of
 * `run.json`, so this is cheap enough to run on every change to a prompt.
 *
 * When the run's predictions do not cover the labeled set, this prints the
 * keyword baseline alone and writes `eval: null`. It does not score the model
 * over the rows it happens to have. Slice #4's sweep is what makes the model
 * column real; until then the honest report is the one that says so.
 */

const TRUTH_PATH = "data/ground_truth_labeled_sample.csv";
const EXPORT_PATH = "data/volunteer_survey_export.csv";

function pct(value: number): string {
  return value.toFixed(2).padStart(5);
}

/** The two reasons a rate is unreadable need different responses, so they say so. */
const UNMEASURABLE = {
  "low-support": "  (support too low to read)",
  "taxonomy-mismatch": "  (labels use a different taxonomy — not comparable)",
} as const satisfies Record<NonNullable<ClassMetrics["unmeasurableReason"]>, string>;

function row(metrics: ClassMetrics): string {
  const flag = metrics.unmeasurableReason === null ? "" : UNMEASURABLE[metrics.unmeasurableReason];
  return (
    `    ${metrics.className.padEnd(22)}` +
    ` P ${pct(metrics.precision)}  R ${pct(metrics.recall)}` +
    `  n ${String(metrics.support).padStart(3)}` +
    `  [tp ${metrics.tp} fp ${metrics.fp} fn ${metrics.fn}]${flag}`
  );
}

function render(report: EvalReport, modelScored: boolean): string {
  const lines = [`\n  ${report.split.toUpperCase()} — ${report.totalLabeled} labeled responses`];

  if (modelScored) {
    lines.push("\n  signal (model)");
    for (const metrics of report.signal) lines.push(row(metrics));
    lines.push("\n  engagement type (model)");
    for (const metrics of report.engagementType) lines.push(row(metrics));
    lines.push("\n  service recovery (model)");
    lines.push(row(report.serviceRecovery));
  }

  // Printed on every run, scored or not. A model number with nothing beside it
  // cannot be attributed (PRD #1 §SMART criteria).
  lines.push("\n  signal (keyword baseline)");
  for (const metrics of report.baseline.signal) lines.push(row(metrics));

  if (report.excluded.length > 0) {
    lines.push(`\n  excluded — ${report.excluded.length} label(s) the harness could not score`);
    for (const { responseId, reason } of report.excluded) {
      lines.push(`    ${responseId}: ${reason}`);
    }
  }

  return lines.join("\n");
}

const program = Effect.gen(function* () {
  const truth = yield* loadGroundTruth(TRUTH_PATH);
  const responses = yield* loadResponses(EXPORT_PATH);

  const baseline = keywordBaseline(responses);
  const { dev, holdout } = splitLabeled(truth);

  // The raw object is kept as the write-back base. `parseRun` validates it and
  // strips unknown keys, so writing the *parsed* value back would delete every
  // field the schema has not caught up with — see `withEval`.
  const raw = JSON.parse(yield* Effect.promise(() => readFile(RUN_PATH, "utf8"))) as Record<
    string,
    unknown
  >;
  const run = parseRun(raw);
  const labeled = new Set(truth.map((label) => label.responseId));
  const covered = run.leads.filter((lead) => labeled.has(lead.responseId)).length;
  const modelScored = covered === truth.length;

  // The model column is scored against the run's own leads; the baseline is
  // always scored. When the run does not cover the labeled set, the baseline
  // stands in as `predictions` so the report is still computable, and the
  // model sections are simply not printed — rather than printed as zeroes.
  const predictions = modelScored ? run.leads : baseline;

  const report = (split: "dev" | "holdout", rows: typeof dev): EvalReport =>
    evaluate({ split, truth: rows, predictions, baseline });

  const scored: EvalRun = { dev: report("dev", dev), holdout: report("holdout", holdout) };

  console.log(
    modelScored
      ? `\nScored ${run.leads.length} predictions from ${RUN_PATH} against ${truth.length} labels.`
      : `\n${RUN_PATH} covers ${covered} of ${truth.length} labeled responses — not enough to` +
          " score the model. Reporting the keyword baseline only; run the sweep (#4) first.",
  );
  console.log(render(scored.dev, modelScored));
  console.log(render(scored.holdout, modelScored));

  // `eval` stays null unless the model was actually scored: the field is a
  // claim about this run, and a baseline-only report published under it would
  // read as a model result to anyone who did not run the command themselves.
  const updated = withEval(raw, modelScored ? scored : null);
  yield* Effect.promise(() => writeFile(RUN_PATH, `${JSON.stringify(updated, null, 2)}\n`, "utf8"));
  console.log(
    `\nWrote eval: ${modelScored ? "dev + holdout reports" : "null (not scored)"} to ${RUN_PATH}\n`,
  );
});

Effect.runPromise(program).catch((error) => {
  console.error(error);
  process.exit(1);
});
