import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load";
import type { SentenceVerdict } from "../domain/engagement";
import { readRun } from "../run/read";
import { writeRun } from "./emit";
import { RateLimited, SchemaInvalid } from "./errors";
import { loadResponses } from "./ingest";
import { routeAll } from "./route";
import { sweep } from "./sweep";

/**
 * The whole spine over the real export, with only the model swapped out.
 *
 * Everything `pnpm run sweep` does except the Gemini call is exercised here:
 * the committed config, all 384 rows of the actual CSV, the bounded sweep, the
 * id-based re-pairing, and the `run.json` round trip. The model is the one
 * thing that cannot run in CI — it needs a key and it costs money — so it is
 * injected, and slice #3's eval harness is what exercises it for real.
 *
 * This is the check that the pieces compose *at the size they will actually
 * run*. The unit tests all use two to four rows; concurrency, ordering, and the
 * failure tally are exactly the properties that behave differently at 384.
 */

const EXPORT_PATH = "data/volunteer_survey_export.csv";

function offer(): SentenceVerdict[] {
  return [
    {
      column: "q6_what_could_improve",
      sentenceIndex: 0,
      quote: "That said, put me down for next fall.",
      signal: "strong",
      engagementType: "volunteer_again",
      confidence: 0.95,
      serviceRecovery: false,
      quotable: null,
    },
  ];
}

describe("the full sweep over the real export", () => {
  it("classifies all 384 rows and round-trips them through run.json", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "vir-sweep-")), "run.json");

    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfig();
        const responses = yield* loadResponses(EXPORT_PATH);

        const result = yield* sweep(responses, config, { classify: () => Effect.succeed(offer()) });
        const leads = routeAll(responses, result.verdicts, config);

        yield* writeRun(leads, {
          path,
          generatedAt: "2026-08-08T12:00:00Z",
          config,
          failures: result.failures,
          partial: result.partial,
        });

        return result;
      }),
    );

    expect(run.attempted).toBe(384);
    expect(run.verdicts).toHaveLength(384);
    expect(run.partial).toBe(false);

    const written = await readRun(path);
    expect(written.counts.responses).toBe(384);
    expect(written.failures).toEqual({ RateLimited: 0, SchemaInvalid: 0, Transient: 0 });
  });

  it("keeps every surviving lead on its own volunteer when rows fail across the batch", async () => {
    // Every tenth row fails, so the verdict list is 346 long against 384 rows
    // and the two no longer align by position. This is the scale version of the
    // mis-pairing `routeAll` exists to prevent — at 384 rows with concurrency,
    // an index-based pairing would silently rewrite most of the queue.
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfig();
        const responses = yield* loadResponses(EXPORT_PATH);

        const result = yield* sweep(responses, config, {
          classify: (row) =>
            Number(row.responseId.replace(/\D/g, "")) % 10 === 0
              ? Effect.fail(new SchemaInvalid({ responseId: row.responseId }))
              : Effect.succeed(offer()),
          retry: { maxRetries: 3, baseDelay: "1 millis" },
        });

        const leads = routeAll(responses, result.verdicts, config);
        const byId = new Map(responses.map((r) => [r.responseId, r]));

        return { result, leads, byId };
      }),
    );

    expect(run.result.partial).toBe(true);
    expect(run.result.failures.SchemaInvalid).toBeGreaterThan(0);
    expect(run.leads).toHaveLength(run.result.verdicts.length);

    // The property that matters: every lead carries the contact details of the
    // volunteer whose response produced it.
    for (const lead of run.leads) {
      const source = run.byId.get(lead.responseId);
      expect(lead.email).toBe(source?.volunteerEmail);
      expect(lead.name).toBe(source?.volunteerName);
    }
  });

  it("survives a total outage without losing the shape of the report", async () => {
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfig();
        const responses = yield* loadResponses(EXPORT_PATH);

        return yield* sweep(responses, config, {
          classify: () => Effect.fail(new RateLimited({})),
          retry: { maxRetries: 1, baseDelay: "1 millis" },
        });
      }),
    );

    expect(run.attempted).toBe(384);
    expect(run.verdicts).toEqual([]);
    expect(run.failures.RateLimited).toBe(384);
    expect(run.partial).toBe(true);
  });
});
