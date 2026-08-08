import { writeFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import type { Config } from "../config/load";
import { RUN_PATH } from "../run/read";
import { type EvalRun, parseRun, type RunCounts, type RunFile } from "../run/run-file";
import { isUnmapped, isUnowned, type RoutedLead } from "./route";

export class EmitError extends Data.TaggedError("EmitError")<{
  readonly path: string;
  readonly reason: string;
}> {}

export type WriteRunOptions = {
  path?: string;
  /** Injected rather than read from the clock, so a run is reproducible and diffable. */
  generatedAt: string;
  /** The config this run routed with. Its roster is denormalised into the file. */
  config: Config;
  /** True when this run does not cover the whole export. */
  partial?: boolean;
  /**
   * How this run scored against the labeled sample.
   *
   * Defaults to `null` — "not scored" — rather than to an empty report,
   * because a caller that forgot to score should produce a file that says so
   * rather than one full of zeroes indistinguishable from a failing model.
   * `pnpm eval` fills it in once a run's predictions cover the labeled set.
   */
  eval?: EvalRun | null;
};

function count(leads: RoutedLead[]): RunCounts {
  return {
    responses: leads.length,
    routed: leads.filter((l) => l.signal !== "none").length,
    unowned: leads.filter(isUnowned).length,
    unmapped: leads.filter(isUnmapped).length,
    multiIntent: leads.filter((l) => l.multiIntent).length,
    serviceRecovery: leads.filter((l) => l.serviceRecovery).length,
  };
}

/**
 * Write the routed leads to `run.json`.
 *
 * This file is the entire contract with the demo: the app reads it and never
 * calls the model, so a rate limit or a network blip cannot kill the
 * presentation (PRD #1 §No-gos). It is committed for the same reason.
 *
 * The counts ride along rather than being recomputed in the UI because two of
 * them are claims about *reliability*, not about the data — `unowned` says the
 * routing table has a gap, `partial` says the run does not describe the whole
 * export. Both have to be visible on the page rather than inferred from a list
 * that looks a bit short. Slice #4 adds failure counts by tag alongside them.
 *
 * `generatedAt` is injected rather than read from the clock so a re-run with
 * the same inputs produces a diffable file instead of noise.
 */
export function writeRun(
  leads: RoutedLead[],
  options: WriteRunOptions,
): Effect.Effect<void, EmitError> {
  const path = options.path ?? RUN_PATH;

  const { sources } = options.config;

  const run: RunFile = {
    generatedAt: options.generatedAt,
    // Three files now, so this is the set rather than the one. Joined into a
    // string rather than made an object because the machine-readable half of
    // "is this a placeholder" is the per-row `inferred` flag below — this field
    // is for a human reading the header.
    configSource: [sources.teams, sources.categories, sources.counties].join(", "),
    recipients: options.config.recipients,
    teams: options.config.teams.map((team) => ({
      id: team.id,
      label: team.label,
      inferred: team.inferred ?? false,
    })),
    categories: options.config.categories.map((category) => ({
      id: category.id,
      label: category.label,
      inferred: category.inferred ?? false,
    })),
    counties: options.config.counties.map((row) => ({
      school: row.school,
      county: row.county,
      inferred: row.inferred ?? false,
    })),
    partial: options.partial ?? false,
    counts: count(leads),
    leads,
    eval: options.eval ?? null,
  };

  // Validated on the way out, not only on the way back in. `parseRun` already
  // guards the app, but a run that fails it is a file the reader will reject —
  // and a sweep that discovers that after 384 model calls has paid for the
  // answer twice. This is also the only place the category cross-check can fire
  // before the cost is sunk: it catches a prompt whose taxonomy has drifted from
  // the routing config, which is otherwise invisible until every lead lands in
  // `unowned`.
  return Effect.try({
    try: () => parseRun(run),
    catch: (cause) => new EmitError({ path, reason: String(cause) }),
  }).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () => writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8"),
        catch: (cause) => new EmitError({ path, reason: String(cause) }),
      }),
    ),
  );
}
