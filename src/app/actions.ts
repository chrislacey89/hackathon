"use server";

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { countCsvDataRows } from "../run/csv-rows";
import { UPLOADED_RUN_PATH } from "../run/read";
import { appendSentMark } from "../run/sent";

/**
 * The app's two write paths, both Server Actions.
 *
 * Neither imports `src/pipeline/`. Marking sent appends to a JSONL through
 * `src/run/sent.ts`; uploading spawns the sweep script as a child process, so
 * the Effect runtime and the AI SDK stay out of the app's module graph
 * entirely — the same boundary `readRun` keeps on the read side.
 */

/** ~0.5s per row at the sweep's default concurrency, measured on the full export. */
const SECONDS_PER_ROW = 0.5;
const MAX_LIVE_ROWS = 60;
const MAX_BYTES = 2 * 1024 * 1024;
const SWEEP_TIMEOUT_MS = 180_000;

export async function setSent(responseId: string, runId: string, sent: boolean): Promise<void> {
  await appendSentMark({
    responseId,
    runId,
    action: sent ? "sent" : "unsent",
    at: new Date().toISOString(),
  });
  revalidatePath("/");
}

export type UploadState = { error: string } | null;

export async function uploadCsv(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a CSV file first." };
  }
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return { error: `"${file.name}" is not a .csv file.` };
  }
  if (file.size > MAX_BYTES) {
    return { error: "That file is over 2 MB — the live path is for small exports." };
  }

  const text = await file.text();
  const rows = countCsvDataRows(text);
  if (rows === 0) {
    return { error: "No data rows found — is the header the only line?" };
  }
  if (rows > MAX_LIVE_ROWS) {
    const minutes = Math.max(1, Math.ceil((rows * SECONDS_PER_ROW) / 60));
    return {
      error: `${rows} rows would take ~${minutes} min to classify live. The full export is already classified — see the sidebar. Live upload takes up to ${MAX_LIVE_ROWS} rows.`,
    };
  }

  await mkdir("data/uploads", { recursive: true });
  const savedPath = `data/uploads/upload-${Date.now()}.csv`;
  await writeFile(savedPath, text, "utf8");

  const failure = await runSweep(savedPath);
  if (failure) return { error: failure };

  // Outside any try/catch: redirect() throws its control-flow error on purpose.
  redirect("/?view=uploaded");
}

/** Resolves to null on success, or a message for the upload form. Never rejects. */
function runSweep(inputPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--env-file-if-exists=.env.local", "src/pipeline/sweep-run.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, SWEEP_INPUT: inputPath, SWEEP_OUTPUT: UPLOADED_RUN_PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    // Progress lines land in the dev-server terminal, which is where a demo
    // driver is already looking when the sweep runs.
    child.stdout.pipe(process.stdout);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SWEEP_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(`Could not start the sweep: ${String(error)}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve("Triage timed out after 3 minutes. The committed full run is unaffected.");
      } else if (code === 0) {
        resolve(null);
      } else {
        const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(-300);
        resolve(`Triage failed (exit ${code}). ${tail || "See the dev server log."}`);
      }
    });
  });
}
