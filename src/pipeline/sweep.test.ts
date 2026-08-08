import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Config } from "../config/load";
import type { SentenceVerdict } from "../domain/engagement";
import { type ClassifyError, RateLimited, SchemaInvalid, Transient } from "./errors";
import type { SurveyResponse } from "./ingest";
import { sweep } from "./sweep";

/**
 * The sweep is where Effect earns its place: 384 calls against a rate limit
 * nobody has read off the dashboard yet. Everything worth testing here is a
 * *reliability* property — did we stay under the concurrency bound, did we
 * retry the errors worth retrying and only those, and does a run that lost
 * rows say so — so every test injects a classify function instead of calling
 * the model.
 *
 * Injecting `classify` is mocking a seam we own (`classify.ts` is ours), which
 * is the case GOOS permits. The model boundary itself is never mocked here;
 * `classify.ts` owns that, and slice #3's eval harness exercises it for real.
 */

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-1",
    submittedAt: "2026-05-01",
    program: "JA in a Day",
    school: "Northside Elementary",
    volunteerName: "Dana Reyes",
    volunteerEmail: "dana@acme.com",
    employer: "Acme Corp",
    roleThisYear: "Classroom volunteer",
    q1OverallSatisfaction: 5,
    q2WouldRecommend: 5,
    q3FeltPrepared: 4,
    q4VolunteerAgain: true,
    q5WhatWentWell: "The students were engaged.",
    q6WhatCouldImprove: null,
    q7AnythingElse: null,
    optInContact: true,
    ...overrides,
  };
}

function rows(count: number): SurveyResponse[] {
  return Array.from({ length: count }, (_, i) => response({ responseId: `JA-${i + 1}` }));
}

const CONFIG: Config = {
  sources: {
    teams: "teams.example.json",
    categories: "categories.example.json",
    counties: "counties.example.json",
  },
  nearMissCap: 25,
  concurrency: 4,
  recipients: [{ id: "r-1", name: "Program Lead", email: "program@ja.org" }],
  teams: [
    {
      id: "t-1",
      label: "Placeholder",
      owns: [{ category: "volunteer_again", county: "Allen" }],
      recipientIds: ["r-1"],
    },
  ],
  categories: [{ id: "volunteer_again", label: "Volunteer again", description: "d" }],
  counties: [{ school: "Northside Elementary", county: "Allen" }],
};

function verdict(overrides: Partial<SentenceVerdict> = {}): SentenceVerdict {
  return {
    column: "q5_what_went_well",
    sentenceIndex: 0,
    quote: "Put me down for next fall.",
    signal: "strong",
    engagementType: "volunteer_again",
    confidence: 0.9,
    serviceRecovery: false,
    // The sweep is indifferent to quotability — it carries verdicts through
    // without reading them — but the field is required, so the fixture states
    // it rather than leaving the shape incomplete.
    quotable: null,
    ...overrides,
  };
}

describe("sweep", () => {
  it("returns one response verdict per row, and a clean reliability report", async () => {
    const result = await Effect.runPromise(
      sweep(rows(2), CONFIG, { classify: () => Effect.succeed([verdict()]) }),
    );

    expect(result.verdicts.map((v) => v.responseId)).toEqual(["JA-1", "JA-2"]);
    expect(result.verdicts[0]?.signal).toBe("strong");
    expect(result.attempted).toBe(2);
    expect(result.partial).toBe(false);
    expect(result.failures).toEqual({ RateLimited: 0, SchemaInvalid: 0, Transient: 0 });
  });

  /**
   * Records the high-water mark of rows in flight at once.
   *
   * `yieldNow` rather than a sleep: it hands control back to the scheduler so
   * every fiber the bound permits is started before any of them finishes, which
   * makes the peak deterministic without coupling the test to wall-clock time.
   */
  function peakInFlight() {
    let inFlight = 0;
    let peak = 0;

    const classify = () =>
      Effect.gen(function* () {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        yield* Effect.yieldNow();
        yield* Effect.yieldNow();
        inFlight -= 1;
        return [verdict()];
      });

    return { classify, peak: () => peak };
  }

  it("runs rows in parallel, never more at once than the configured bound", async () => {
    const probe = peakInFlight();

    await Effect.runPromise(sweep(rows(12), CONFIG, { classify: probe.classify }));

    // Not 1: `Effect.forEach` defaults to sequential, and 384 calls run serially
    // is a silent failure — no error, just a sweep that takes all afternoon.
    expect(probe.peak()).toBe(4);
  });

  it("takes the bound from config rather than a constant of its own", async () => {
    const probe = peakInFlight();

    await Effect.runPromise(
      sweep(rows(12), { ...CONFIG, concurrency: 2 }, { classify: probe.classify }),
    );

    expect(probe.peak()).toBe(2);
  });
});

/**
 * Retry is deliberately zero-delay in these tests.
 *
 * The schedule is injected rather than hardcoded precisely so tests can turn
 * the wall clock off. A suite that actually slept through exponential backoff
 * would be coupled to real time, and the fix for that is injection — never a
 * longer `testTimeout`.
 */
const FAST_RETRY = { maxRetries: 3, baseDelay: "1 millis" } as const;

/** A classify that fails a fixed number of times, then succeeds. Counts attempts. */
function flaky(failures: number, error: () => ClassifyError) {
  let attempts = 0;

  const classify = () =>
    Effect.suspend(() => {
      attempts += 1;
      return attempts <= failures ? Effect.fail(error()) : Effect.succeed([verdict()]);
    });

  return { classify, attempts: () => attempts };
}

describe("sweep retry policy", () => {
  it("never retries a schema failure, because the next attempt fails identically", async () => {
    const probe = flaky(Number.POSITIVE_INFINITY, () => new SchemaInvalid({ responseId: "JA-1" }));

    const result = await Effect.runPromise(
      sweep(rows(1), CONFIG, { classify: probe.classify, retry: FAST_RETRY }),
    );

    expect(probe.attempts()).toBe(1);
    expect(result.failures.SchemaInvalid).toBe(1);
  });

  it("retries a rate limit and keeps the verdict when it clears", async () => {
    const probe = flaky(2, () => new RateLimited({}));

    const result = await Effect.runPromise(
      sweep(rows(1), CONFIG, { classify: probe.classify, retry: FAST_RETRY }),
    );

    expect(probe.attempts()).toBe(3);
    expect(result.verdicts).toHaveLength(1);
    // A row that recovered is not a lost row. Counting it would make run.json
    // claim missing data that is sitting right there in `verdicts`.
    expect(result.failures.RateLimited).toBe(0);
    expect(result.partial).toBe(false);
  });

  it("retries a transient failure too", async () => {
    const probe = flaky(1, () => new Transient({ status: 503 }));

    const result = await Effect.runPromise(
      sweep(rows(1), CONFIG, { classify: probe.classify, retry: FAST_RETRY }),
    );

    expect(probe.attempts()).toBe(2);
    expect(result.verdicts).toHaveLength(1);
  });

  it("stops at the configured retry budget rather than trying forever", async () => {
    const probe = flaky(Number.POSITIVE_INFINITY, () => new RateLimited({}));

    await Effect.runPromise(
      sweep(rows(1), CONFIG, { classify: probe.classify, retry: { ...FAST_RETRY, maxRetries: 2 } }),
    );

    // The first call is not a retry: a budget of 2 means three attempts total.
    expect(probe.attempts()).toBe(3);
  });
});

/**
 * What a run says about itself when it did not get everything.
 *
 * A partial run rendering as complete is the failure PRD #1 §Implementation
 * Decisions names outright: Karen reads "384 responses, 12 leads" and never
 * learns that 30 rows were dropped, so the missing volunteers look like
 * volunteers who expressed nothing.
 */
describe("sweep reliability reporting", () => {
  /** Fails one nominated row forever; every other row succeeds. */
  function failing(responseId: string, error: () => ClassifyError) {
    return (row: SurveyResponse) =>
      row.responseId === responseId ? Effect.fail(error()) : Effect.succeed([verdict()]);
  }

  it("marks the run partial when a row exhausts its retries, and keeps the rest", async () => {
    const result = await Effect.runPromise(
      sweep(rows(4), CONFIG, {
        classify: failing("JA-3", () => new RateLimited({})),
        retry: FAST_RETRY,
      }),
    );

    expect(result.partial).toBe(true);
    expect(result.failures.RateLimited).toBe(1);
    expect(result.attempted).toBe(4);
    // The other three rows are not collateral. `Effect.forEach` interrupts its
    // siblings on the first failure unless each row is made total first, which
    // would lose three good leads to one 429.
    expect(result.verdicts.map((v) => v.responseId)).toEqual(["JA-1", "JA-2", "JA-4"]);
  });

  it("still produces a well-formed result when every row fails", async () => {
    const result = await Effect.runPromise(
      sweep(rows(3), CONFIG, {
        classify: () => Effect.fail(new Transient({ status: 500 })),
        retry: FAST_RETRY,
      }),
    );

    expect(result.verdicts).toEqual([]);
    expect(result.failures).toEqual({ RateLimited: 0, SchemaInvalid: 0, Transient: 3 });
    expect(result.partial).toBe(true);
    expect(result.attempted).toBe(3);
  });

  it("counts each tag separately, so the report says which way it broke", async () => {
    const errors: Record<string, () => ClassifyError> = {
      "JA-1": () => new RateLimited({}),
      "JA-2": () => new SchemaInvalid({ responseId: "JA-2" }),
      "JA-3": () => new Transient({ status: 500 }),
    };

    const result = await Effect.runPromise(
      sweep(rows(4), CONFIG, {
        classify: (row) => {
          const error = errors[row.responseId];
          return error === undefined ? Effect.succeed([verdict()]) : Effect.fail(error());
        },
        retry: FAST_RETRY,
      }),
    );

    expect(result.failures).toEqual({ RateLimited: 1, SchemaInvalid: 1, Transient: 1 });
    expect(result.verdicts).toHaveLength(1);
  });

  it("reports a clean run over no rows at all rather than failing", async () => {
    const result = await Effect.runPromise(
      sweep([], CONFIG, { classify: () => Effect.succeed([verdict()]), retry: FAST_RETRY }),
    );

    // Zero rows is a complete description of zero rows. Marking it partial would
    // put a "this run is incomplete" banner on an empty week that was fine.
    expect(result).toEqual({
      verdicts: [],
      failures: { RateLimited: 0, SchemaInvalid: 0, Transient: 0 },
      partial: false,
      attempted: 0,
    });
  });
});
