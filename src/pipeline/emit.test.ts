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
    county: "Allen",
    school: "Northrop HS",
    submittedAt: "2026-01-01T09:00",
    name: "Dana Reyes",
    email: "dana@acme.com",
    employer: "Acme Corp",
    program: "JA in a Day",
    ...overrides,
  };
}

const AT = "2026-08-08T12:00:00Z";

const CONFIG: Config = {
  sources: {
    teams: "teams.example.json",
    categories: "categories.example.json",
    counties: "counties.example.json",
  },
  nearMissCap: 25,
  concurrency: 4,
  recipients: [{ id: "r-program", name: "Program Lead", email: "program@ja.org" }],
  teams: [
    {
      id: "program-staff",
      label: "Program Staff",
      owns: [{ category: "volunteer_again", county: "Allen" }],
      recipientIds: ["r-program"],
      inferred: true,
    },
  ],
  categories: [
    { id: "volunteer_again", label: "Volunteer again", description: "d", inferred: true },
  ],
  counties: [{ school: "Northrop HS", county: "Allen", inferred: true }],
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
      unmapped: 0,
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

  it("counts a routable lead whose school has no county as unmapped, not unowned", async () => {
    const path = await runPath();

    await Effect.runPromise(
      writeRun(
        [lead({ teamId: null, recipientIds: [], county: null, school: "Lafayette Jeff HS" })],
        {
          path,
          generatedAt: AT,
          config: CONFIG,
        },
      ),
    );
    const counts = (await readRun(path)).counts;

    // Two gaps, two files, two repairs. Summing them into "not routed" would
    // send an operator to the wrong one.
    expect(counts).toMatchObject({ unmapped: 1, unowned: 0 });
  });

  it("denormalises the categories and the county lookup it routed with", async () => {
    const path = await runPath();

    await Effect.runPromise(writeRun([lead()], { path, generatedAt: AT, config: CONFIG }));
    const run = await readRun(path);

    // The app cannot call the Effect-based config loader, and these carry the
    // labels the UI prints and the `inferred` flags it badges — the job the
    // deleted `TYPE_LABELS satisfies Record<EngagementType, string>` used to do.
    expect(run.categories).toEqual([
      { id: "volunteer_again", label: "Volunteer again", inferred: true },
    ]);
    expect(run.counties).toEqual([{ school: "Northrop HS", county: "Allen", inferred: true }]);
    expect(run.configSource).toBe(
      "teams.example.json, categories.example.json, counties.example.json",
    );
  });

  it("refuses to write a lead citing a category the run does not carry", async () => {
    const path = await runPath();

    // The check that replaces `z.enum(ENGAGEMENT_TYPES)`. A run naming a
    // category its own config does not define would render as a raw id beside a
    // lead routed to nobody — indistinguishable from a real routing gap.
    const result = await Effect.runPromise(
      Effect.either(
        writeRun([lead({ engagementType: "speaking", engagementTypes: ["speaking"] })], {
          path,
          generatedAt: AT,
          config: CONFIG,
        }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.reason).toMatch(/speaking/);
    // And nothing was written — a rejected run must not leave a half-valid file
    // behind for the app to read.
    await expect(readFile(path, "utf8")).rejects.toThrow();
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
