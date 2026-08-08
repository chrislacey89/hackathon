import { writeFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import type { Config } from "../config/load";
import { RUN_PATH } from "../run/read";
import type { RunCounts, RunFile } from "../run/run-file";
import { isUnowned, type RoutedLead } from "./route";

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
};

function count(leads: RoutedLead[]): RunCounts {
  return {
    responses: leads.length,
    routed: leads.filter((l) => l.signal !== "none").length,
    unowned: leads.filter(isUnowned).length,
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

  const run: RunFile = {
    generatedAt: options.generatedAt,
    configSource: options.config.source,
    recipients: options.config.recipients,
    teams: options.config.teams.map((team) => ({
      id: team.id,
      label: team.label,
      inferred: team.inferred ?? false,
    })),
    partial: options.partial ?? false,
    counts: count(leads),
    leads,
  };

  return Effect.tryPromise({
    try: () => writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8"),
    catch: (cause) => new EmitError({ path, reason: String(cause) }),
  });
}
