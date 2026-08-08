import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Sent marks — Karen's assertion that she pasted a lead into an email and sent
 * it. The tool never observes sending, so a mark is a *claim*, kept apart from
 * anything the pipeline authored.
 *
 * A JSONL file next to `run.json`, append-only: marking and un-marking both
 * append a record, and the view folds the log left-to-right (last action per
 * lead wins). `fs.appendFile` opens with `O_APPEND`, atomic per write, so no
 * lock is needed. Marks are keyed to a run by `generatedAt` — an uploaded run
 * keeps its own marks — and they gate nothing but display: a forgotten mark
 * can change what the page shows, never what a sweep routes.
 *
 * Effect-free on purpose, like everything in `src/run/`: this is the app's
 * write path, and the pipeline runtime stays out of it.
 */

export const SENT_PATH = "sent-marks.jsonl";

export const SentMarkSchema = z.object({
  responseId: z.string().min(1),
  /** `generatedAt` of the run the mark was made against. */
  runId: z.string().min(1),
  action: z.enum(["sent", "unsent"]),
  /** When she said so — a human claim, not an observation. */
  at: z.string(),
});

export type SentMark = z.infer<typeof SentMarkSchema>;

export async function appendSentMark(mark: SentMark, path: string = SENT_PATH): Promise<void> {
  await appendFile(path, `${JSON.stringify(SentMarkSchema.parse(mark))}\n`, "utf8");
}

/** Read every mark ever appended. A file that does not exist yet is an empty log. */
export async function readSentMarks(path: string = SENT_PATH): Promise<SentMark[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => SentMarkSchema.parse(JSON.parse(line)));
}

/** Fold the log into the set of leads currently marked sent for one run. */
export function sentIds(marks: SentMark[], runId: string): Set<string> {
  const ids = new Set<string>();
  for (const mark of marks) {
    if (mark.runId !== runId) continue;
    if (mark.action === "sent") ids.add(mark.responseId);
    else ids.delete(mark.responseId);
  }
  return ids;
}
