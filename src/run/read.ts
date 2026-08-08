import { readFile } from "node:fs/promises";
import { parseRun, type RunFile } from "./run-file";

export const RUN_PATH = "run.json";

/**
 * Read a committed run.
 *
 * Plain promises, no Effect — this is the app's side of the boundary, and the
 * Next.js app is meant to stay ignorant of the pipeline's runtime (PRD #1
 * §Implementation Decisions). It is also the reason the demo cannot be killed
 * by a rate limit or a network blip: the request path reads a file.
 *
 * Rejects rather than returning an empty run. A page rendering "no leads"
 * because it silently swallowed a parse error would be indistinguishable from
 * a page rendering "no leads" because JA had none.
 */
export async function readRun(path: string = RUN_PATH): Promise<RunFile> {
  return parseRun(JSON.parse(await readFile(path, "utf8")));
}
