import { readFile } from "node:fs/promises";
import { parseRun, type RunFile, RunFileError } from "./run-file";

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

/** Where an uploaded CSV's classified run lands. Gitignored — it is demo state, not an artifact. */
export const UPLOADED_RUN_PATH = "run.uploaded.json";

/**
 * Read the uploaded run, if one exists.
 *
 * `null` for "nobody has uploaded anything" is a real state the page renders
 * (no second queue in the sidebar). A file that no longer matches the schema
 * is treated the same way: `writeRun` produces valid files by construction,
 * so a parse failure here means stale state left over from before a schema
 * change — demo debris that must not take the committed run down with it.
 */
export async function readUploadedRun(): Promise<RunFile | null> {
  try {
    return await readRun(UPLOADED_RUN_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof RunFileError) return null;
    throw error;
  }
}
