import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Config } from "../config/load";
import { readRun } from "../run/read";
import { RunFileError } from "../run/run-file";
import { writeRun } from "./emit";
import type { RoutedLead } from "./route";

function lead(overrides: Partial<RoutedLead> = {}): RoutedLead {
  return {
    responseId: "JA-1",
    signal: "strong",
    engagementType: "volunteer_again",
    engagementTypes: ["volunteer_again"],
    confidence: 0.9,
    quote: "Put me down for next fall.",
    sourceColumn: "q6_what_could_improve",
    serviceRecovery: false,
    multiIntent: false,
    verdicts: [],
    teamId: "program-staff",
    recipientIds: ["r-program"],
    name: "Dana Reyes",
    email: "dana@acme.com",
    employer: "Acme Corp",
    program: "JA in a Day",
    ...overrides,
  };
}

const AT = "2026-08-08T12:00:00Z";

const CONFIG: Config = {
  source: "teams.example.json",
  nearMissCap: 25,
  concurrency: 4,
  recipients: [{ id: "r-program", name: "Program Lead", email: "program@ja.org" }],
  teams: [
    {
      id: "program-staff",
      label: "Program Staff",
      owns: ["volunteer_again"],
      recipientIds: ["r-program"],
      inferred: true,
    },
  ],
};

async function runPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "vir-run-")), "run.json");
}

describe("writeRun", () => {
  it("writes a run the reader can load back", async () => {
    const path = await runPath();

    await Effect.runPromise(writeRun([lead()], { path, generatedAt: AT, config: CONFIG }));
    const run = await readRun(path);

    expect(run.leads).toHaveLength(1);
    expect(run.leads[0]?.responseId).toBe("JA-1");
    expect(run.generatedAt).toBe(AT);
  });

  it("counts responses, routed leads, multi-intent and service recovery", async () => {
    const path = await runPath();

    await Effect.runPromise(
      writeRun(
        [
          lead(),
          lead({ responseId: "JA-2", multiIntent: true }),
          lead({ responseId: "JA-3", signal: "none", engagementType: null, engagementTypes: [] }),
          lead({ responseId: "JA-4", serviceRecovery: true }),
        ],
        { path, generatedAt: AT, config: CONFIG },
      ),
    );
    const run = await readRun(path);

    expect(run.counts).toEqual({
      responses: 4,
      routed: 3,
      unowned: 0,
      multiIntent: 1,
      serviceRecovery: 1,
    });
  });

  it("counts a routable lead that reaches nobody as unowned", async () => {
    const path = await runPath();

    await Effect.runPromise(
      writeRun([lead({ teamId: null, recipientIds: [] })], {
        path,
        generatedAt: AT,
        config: CONFIG,
      }),
    );

    expect((await readRun(path)).counts.unowned).toBe(1);
  });

  it("carries the sweep's failure counts, so the report says how the run broke", async () => {
    // `counts` describes the data; `failures` describes the run that produced
    // it. A reader seeing "12 leads" needs both to know whether 12 is the
    // answer or just what survived.
    const path = await runPath();

    await Effect.runPromise(
      writeRun([lead()], {
        path,
        generatedAt: AT,
        config: CONFIG,
        failures: { RateLimited: 2, SchemaInvalid: 1, Transient: 0 },
        partial: true,
      }),
    );

    expect((await readRun(path)).failures).toEqual({
      RateLimited: 2,
      SchemaInvalid: 1,
      Transient: 0,
    });
  });

  it("defaults every failure tag to zero rather than omitting the key", async () => {
    const path = await runPath();

    await Effect.runPromise(writeRun([lead()], { path, generatedAt: AT, config: CONFIG }));

    expect((await readRun(path)).failures).toEqual({
      RateLimited: 0,
      SchemaInvalid: 0,
      Transient: 0,
    });
  });

  it("marks the tracer's run partial, because one response is not the export", async () => {
    const path = await runPath();

    await Effect.runPromise(
      writeRun([lead()], { path, generatedAt: AT, config: CONFIG, partial: true }),
    );

    expect((await readRun(path)).partial).toBe(true);
  });

  it("writes readable JSON rather than one long line", async () => {
    const path = await runPath();

    await Effect.runPromise(writeRun([lead()], { path, generatedAt: AT, config: CONFIG }));

    expect(await readFile(path, "utf8")).toMatch(/\n {2}"counts"/);
  });
});

describe("readRun", () => {
  it("rejects a missing run rather than returning an empty one", async () => {
    await expect(readRun("does/not/exist.json")).rejects.toThrow();
  });

  it("rejects a run whose shape does not match, naming the offending field", async () => {
    const path = await runPath();
    await writeFile(path, '{"leads":"nope"}');

    await expect(readRun(path)).rejects.toThrow(RunFileError);
    await expect(readRun(path)).rejects.toThrow(/leads/);
  });

  it("loads the committed run.json the app renders from", async () => {
    const run = await readRun("run.json");

    expect(run.leads.length).toBeGreaterThan(0);
  });
});
